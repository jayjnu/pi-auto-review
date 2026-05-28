import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import {
  buildAutoFixTask,
  buildReviewFingerprint,
  buildReviewTask,
  hasBlockingReviewFindings,
  isFileMutationToolResult,
  parseChangedFiles,
  shouldRunReview,
} from './helpers.ts';
import { runReviewer } from './runner.ts';

const AUTO_REVIEW_MESSAGE_TYPE = 'auto-review';
const REVIEWED_DIFF_ENTRY_TYPE = 'auto-review-reviewed-diff';
const AUTO_REVIEW_STATUS_KEY = 'auto-review';
const MAX_UNTRACKED_HASH_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

interface ReviewRequest {
  cwd: string;
  ui?: ExtensionUIContext;
  beforeStatus: string;
  beforeHead: string;
  afterStatus: string;
  afterHead: string;
}

interface PendingReviewRequest {
  cwd: string;
  ui?: ExtensionUIContext;
  beforeStatus: string;
  beforeHead: string;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`);
}

async function hashTextFile(path: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let inspectedBytes = 0;
    let isBinary = false;
    const stream = createReadStream(path);

    stream.on('data', (chunk) => {
      if (isBinary) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const inspectLength = Math.min(buffer.length, Math.max(0, BINARY_SNIFF_BYTES - inspectedBytes));
      if (inspectLength > 0 && buffer.subarray(0, inspectLength).includes(0)) {
        isBinary = true;
        stream.destroy();
        resolve(undefined);
        return;
      }
      inspectedBytes += inspectLength;
      hash.update(buffer);
    });
    stream.on('error', (error) => {
      if (!isBinary) reject(error);
    });
    stream.on('end', () => {
      if (!isBinary) resolve(hash.digest('hex'));
    });
  });
}

async function buildUntrackedSnapshot(cwd: string, exec: ExtensionAPI['exec']): Promise<string> {
  const result = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.code !== 0) return '';

  const rows: string[] = [];
  for (const file of result.stdout.split('\0').filter(Boolean).sort()) {
    const absolutePath = resolve(cwd, file);
    if (!isInsideDirectory(cwd, absolutePath)) continue;

    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.size > MAX_UNTRACKED_HASH_BYTES) {
        rows.push(`${file}\t${fileStat.size}\tskipped-large`);
        continue;
      }
      const contentHash = await hashTextFile(absolutePath);
      rows.push(`${file}\t${fileStat.size}\t${contentHash ?? 'skipped-binary'}`);
    } catch (error: unknown) {
      rows.push(`${file}\terror\t${String(error)}`);
    }
  }

  return rows.join('\n');
}

async function getHead(exec: ExtensionAPI['exec'], signal?: AbortSignal): Promise<string> {
  const result = await exec('git', ['rev-parse', '--verify', 'HEAD'], { signal });
  return result.code === 0 ? result.stdout.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseNullSeparatedFiles(output: string): string[] {
  return output.split('\0').filter((file) => file.length > 0);
}

function committedReviewCommands(beforeHead: string, afterHead: string): string[] {
  if (beforeHead && afterHead && beforeHead !== afterHead) {
    return [`git diff --no-ext-diff ${beforeHead}..${afterHead}`, `git diff --name-only ${beforeHead}..${afterHead}`];
  }
  if (afterHead) return [`git show --no-ext-diff --stat --patch ${afterHead}`, `git show --format= --name-only ${afterHead}`];
  return [];
}

async function getCommittedChangeInfo(exec: ExtensionAPI['exec'], beforeHead: string, afterHead: string, signal?: AbortSignal): Promise<{ diff: string; files: string[]; commands: string[] }> {
  if (!afterHead || beforeHead === afterHead) return { diff: '', files: [], commands: [] };

  const commands = committedReviewCommands(beforeHead, afterHead);
  const diff = beforeHead
    ? await exec('git', ['diff', '--no-ext-diff', '--binary', `${beforeHead}..${afterHead}`], { signal })
    : await exec('git', ['show', '--no-ext-diff', '--format=', '--binary', afterHead], { signal });
  const files = beforeHead
    ? await exec('git', ['diff', '--name-only', '-z', `${beforeHead}..${afterHead}`], { signal })
    : await exec('git', ['show', '--format=', '--name-only', '-z', afterHead], { signal });

  return {
    diff: diff.code === 0 ? diff.stdout : '',
    files: files.code === 0 ? parseNullSeparatedFiles(files.stdout) : [],
    commands,
  };
}

function loadReviewedFingerprints(entries: ReadonlyArray<unknown>): Set<string> {
  const fingerprints = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== 'custom' || candidate.customType !== REVIEWED_DIFF_ENTRY_TYPE) continue;
    if (!candidate.data || typeof candidate.data !== 'object') continue;
    const fingerprint = (candidate.data as { fingerprint?: unknown }).fingerprint;
    if (typeof fingerprint === 'string' && fingerprint.length > 0) fingerprints.add(fingerprint);
  }

  return fingerprints;
}

export default function autoReviewExtension(pi: ExtensionAPI) {
  let enabled = true;
  let reviewInProgress = false;
  let sawMutationTool = false;
  let beforeStatus = '';
  let beforeHead = '';
  let autoFixEnabled = true;
  let reviewedFingerprints = new Set<string>();
  let reviewAbortController: AbortController | undefined;
  let pendingReviewRequest: PendingReviewRequest | undefined;
  let sessionActive = false;

  pi.registerFlag('no-auto-review', {
    description: 'Disable automatic post-change code review',
    type: 'boolean',
    default: false,
  });

  pi.registerFlag('no-auto-review-fix', {
    description: 'Disable automatic follow-up fixes for auto-review findings',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('auto-review', {
    description: 'Control automatic post-change code review and auto-fix: on, off, status, fix on, fix off, or fix status',
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === 'on') {
        enabled = true;
        ctx.ui.notify('Auto review enabled', 'info');
        return;
      }
      if (command === 'off') {
        enabled = false;
        ctx.ui.notify('Auto review disabled', 'info');
        return;
      }
      if (command === 'fix on') {
        autoFixEnabled = true;
        ctx.ui.notify('Auto review auto-fix enabled', 'info');
        return;
      }
      if (command === 'fix off') {
        autoFixEnabled = false;
        ctx.ui.notify('Auto review auto-fix disabled', 'info');
        return;
      }
      if (command === '' || command === 'status' || command === 'fix status') {
        ctx.ui.notify(
          `Auto review is ${enabled ? 'enabled' : 'disabled'}; auto-fix is ${autoFixEnabled ? 'enabled' : 'disabled'}; ${reviewedFingerprints.size} reviewed diff fingerprint(s) cached`,
          'info',
        );
        return;
      }
      ctx.ui.notify('Usage: /auto-review on | off | status | fix on | fix off | fix status', 'warning');
    },
  });

  function isStaleSessionError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('This extension ctx is stale');
  }

  function safeNotify(ui: ExtensionUIContext | undefined, message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    if (!sessionActive || !ui) return;
    try {
      ui.notify(message, type);
    } catch (error: unknown) {
      if (!isStaleSessionError(error)) throw error;
    }
  }

  function safeSetStatus(ui: ExtensionUIContext | undefined, text: string | undefined): void {
    if (!sessionActive || !ui) return;
    try {
      ui.setStatus(AUTO_REVIEW_STATUS_KEY, text);
    } catch (error: unknown) {
      if (!isStaleSessionError(error)) throw error;
    }
  }

  function safeSendMessage(message: Parameters<ExtensionAPI['sendMessage']>[0]): void {
    if (!sessionActive) return;
    try {
      pi.sendMessage(message);
    } catch (error: unknown) {
      if (!isStaleSessionError(error)) throw error;
    }
  }

  function safeSendUserMessage(content: Parameters<ExtensionAPI['sendUserMessage']>[0], options?: Parameters<ExtensionAPI['sendUserMessage']>[1]): void {
    if (!sessionActive) return;
    try {
      pi.sendUserMessage(content, options);
    } catch (error: unknown) {
      if (!isStaleSessionError(error)) throw error;
    }
  }

  function safeAppendEntry(customType: string, data: unknown): void {
    if (!sessionActive) return;
    try {
      pi.appendEntry(customType, data);
    } catch (error: unknown) {
      if (!isStaleSessionError(error)) throw error;
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    sessionActive = true;
    enabled = pi.getFlag('no-auto-review') !== true;
    autoFixEnabled = pi.getFlag('no-auto-review-fix') !== true;
    reviewedFingerprints = loadReviewedFingerprints(ctx.sessionManager.getEntries());
  });

  pi.on('session_shutdown', async () => {
    sessionActive = false;
    pendingReviewRequest = undefined;
    reviewInProgress = false;
    reviewAbortController?.abort();
    reviewAbortController = undefined;
  });

  pi.on('agent_start', async (_event, ctx) => {
    sawMutationTool = false;
    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    beforeStatus = status.code === 0 ? status.stdout : '';
    beforeHead = await getHead(pi.exec.bind(pi), ctx.signal);
  });

  pi.on('tool_result', async (event) => {
    if (isFileMutationToolResult(event.toolName, event.isError)) {
      sawMutationTool = true;
    }
  });

  async function scheduleReview(request: ReviewRequest): Promise<void> {
    const committed = await getCommittedChangeInfo(pi.exec.bind(pi), request.beforeHead, request.afterHead);
    const changedFiles = uniqueStrings([...parseChangedFiles(request.afterStatus), ...committed.files]);
    const diff = await pi.exec('git', ['diff', '--no-ext-diff', '--binary']);
    const cachedDiff = await pi.exec('git', ['diff', '--cached', '--no-ext-diff', '--binary']);
    const untrackedSnapshot = await buildUntrackedSnapshot(request.cwd, pi.exec.bind(pi));
    const fingerprint = buildReviewFingerprint({
      status: request.afterStatus,
      diff: diff.code === 0 ? diff.stdout : '',
      cachedDiff: cachedDiff.code === 0 ? cachedDiff.stdout : '',
      committedDiff: committed.diff,
      untrackedSnapshot,
    });

    if (!sessionActive) return;

    if (reviewedFingerprints.has(fingerprint)) {
      safeNotify(request.ui, 'Auto review skipped — this diff was already reviewed', 'info');
      return;
    }

    reviewInProgress = true;
    reviewAbortController = new AbortController();
    const signal = reviewAbortController.signal;
    const hasCommittedChanges = Boolean(request.afterHead && request.beforeHead !== request.afterHead);
    const task = buildReviewTask({
      changedFiles,
      status: request.afterStatus,
      reviewTarget: hasCommittedChanges
        ? `Review the changes committed by the parent Pi agent from ${request.beforeHead || '(no previous HEAD)'} to ${request.afterHead}. Also review any remaining uncommitted diff if present.`
        : undefined,
      suggestedCommands: hasCommittedChanges
        ? [...committed.commands, 'git diff --no-ext-diff', 'git diff --cached --no-ext-diff']
        : undefined,
    });
    const shortFingerprint = fingerprint.slice(0, 12);

    safeNotify(request.ui, 'Auto review started — reviewer will report skills used', 'info');
    safeSetStatus(request.ui, `reviewing ${shortFingerprint}`);

    setTimeout(() => {
      void (async () => {
        try {
          if (!sessionActive) return;
          safeSendMessage({
            customType: AUTO_REVIEW_MESSAGE_TYPE,
            content: [
              'Auto review is running…',
              '',
              `Fingerprint: \`${shortFingerprint}\``,
              `Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : '(none parsed)'}`,
            ].join('\n'),
            display: true,
            details: {
              state: 'running',
              fingerprint,
              changedFiles,
            },
          });

          const result = await runReviewer({
            cwd: request.cwd,
            task,
            signal,
            exec: async (command, args, options) => {
              const execResult = await pi.exec(command, args, options);
              return {
                stdout: execResult.stdout,
                stderr: execResult.stderr,
                code: execResult.code,
              };
            },
          });

          const shouldAutoFix = autoFixEnabled && result.code === 0 && hasBlockingReviewFindings(result.text);
          if (!sessionActive) return;

          if (shouldAutoFix) {
            safeSendUserMessage(buildAutoFixTask({ reviewText: result.text, changedFiles, fingerprint }), { deliverAs: 'followUp' });
          } else {
            safeSendMessage({
              customType: AUTO_REVIEW_MESSAGE_TYPE,
              content: result.text,
              display: true,
              details: {
                code: result.code,
                stderr: result.stderr,
                changedFiles,
                fingerprint,
              },
            });
          }

          if (result.code === 0) {
            reviewedFingerprints.add(fingerprint);
            safeAppendEntry(REVIEWED_DIFF_ENTRY_TYPE, {
              fingerprint,
              reviewedAt: new Date().toISOString(),
              changedFiles,
              autoFixRequested: shouldAutoFix,
            });
          }
        } catch (error: unknown) {
          safeSendMessage({
            customType: AUTO_REVIEW_MESSAGE_TYPE,
            content: `Auto review failed: ${String(error)}`,
            display: true,
            details: { error: String(error), fingerprint, changedFiles },
          });
        } finally {
          safeSetStatus(request.ui, undefined);
          reviewAbortController = undefined;
          reviewInProgress = false;
          if (sessionActive) void runPendingReviewIfNeeded();
        }
      })();
    }, 0);
  }

  function sendReviewFailed(error: unknown): void {
    safeSendMessage({
      customType: AUTO_REVIEW_MESSAGE_TYPE,
      content: `Auto review failed: ${String(error)}`,
      display: true,
      details: { error: String(error) },
    });
  }

  async function runPendingReviewIfNeeded(): Promise<void> {
    const pending = pendingReviewRequest;
    pendingReviewRequest = undefined;
    if (!sessionActive || !pending || !enabled) return;

    try {
      const status = await pi.exec('git', ['status', '--porcelain']);
      const afterStatus = status.code === 0 ? status.stdout : '';
      const afterHead = await getHead(pi.exec.bind(pi));
      if (!shouldRunReview({
        enabled,
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: pending.beforeStatus,
        afterStatus,
        beforeHead: pending.beforeHead,
        afterHead,
      })) {
        return;
      }

      await scheduleReview({
        cwd: pending.cwd,
        ui: pending.ui,
        beforeStatus: pending.beforeStatus,
        beforeHead: pending.beforeHead,
        afterStatus,
        afterHead,
      });
    } catch (error: unknown) {
      sendReviewFailed(error);
    }
  }

  pi.on('agent_end', async (_event, ctx) => {
    try {
      const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
      const afterStatus = status.code === 0 ? status.stdout : '';
      const afterHead = await getHead(pi.exec.bind(pi), ctx.signal);

      if (reviewInProgress) {
        const shouldQueuePendingReview = shouldRunReview({
          enabled,
          reviewInProgress: false,
          sawMutationTool,
          beforeStatus,
          afterStatus,
          beforeHead,
          afterHead,
        });
        if (shouldQueuePendingReview) {
          pendingReviewRequest ??= {
            cwd: ctx.cwd,
            ui: ctx.hasUI ? ctx.ui : undefined,
            beforeStatus,
            beforeHead,
          };
          safeNotify(ctx.hasUI ? ctx.ui : undefined, 'Auto review queued — another review is already running', 'info');
        }
        return;
      }

      if (!shouldRunReview({ enabled, reviewInProgress, sawMutationTool, beforeStatus, afterStatus, beforeHead, afterHead })) {
        return;
      }

      await scheduleReview({
        cwd: ctx.cwd,
        ui: ctx.hasUI ? ctx.ui : undefined,
        beforeStatus,
        beforeHead,
        afterStatus,
        afterHead,
      });
    } catch (error: unknown) {
      sendReviewFailed(error);
    }
  });
}
