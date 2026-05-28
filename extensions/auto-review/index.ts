import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AUTO_REVIEW_PROMPT_MARKER, areSkillCommandsEnabled, buildReviewPrompt, isFileMutationToolResult, isLikelyMutatingBashCommand, isReadOnlyReviewBashCommand, isReviewerSubagentInput, parseChangedFiles, shouldRunReview } from './helpers.ts';

const REVIEW_START_WATCHDOG_MS = 30_000;

export default function autoReviewExtension(pi: ExtensionAPI) {
  let enabled = true;
  let reviewQueued = false;
  let reviewInProgress = false;
  let reviewSubagentCompleted = false;
  let sawMutationTool = false;
  let beforeStatus = '';
  let beforeHead = '';
  let lastQueuedReviewFingerprint = '';
  let queuedReviewPrompt: string | undefined;
  let reviewStartTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewStartWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let startingQueuedReview = false;

  function clearQueuedReview(): void {
    reviewQueued = false;
    queuedReviewPrompt = undefined;
    startingQueuedReview = false;
    if (reviewStartTimer) {
      clearTimeout(reviewStartTimer);
      reviewStartTimer = undefined;
    }
    if (reviewStartWatchdogTimer) {
      clearTimeout(reviewStartWatchdogTimer);
      reviewStartWatchdogTimer = undefined;
    }
  }

  function buildReviewFingerprint(input: { status: string; beforeHead: string; afterHead: string; files: string[] }): string {
    return JSON.stringify({
      status: input.status.trim(),
      beforeHead: input.beforeHead.trim(),
      afterHead: input.afterHead.trim(),
      files: [...input.files].sort(),
    });
  }

  function startQueuedReviewWhenIdle(ctx: ExtensionContext): void {
    if (startingQueuedReview || reviewStartTimer) return;

    const tryStart = () => {
      reviewStartTimer = undefined;
      if (!reviewQueued || !queuedReviewPrompt) return;

      try {
        if (!ctx.isIdle()) {
          reviewStartTimer = setTimeout(tryStart, 25);
          reviewStartTimer.unref?.();
          return;
        }
      } catch {
        clearQueuedReview();
        return;
      }

      const prompt = queuedReviewPrompt;
      // Do not use deliverAs: 'followUp' here. agent_end runs after the core
      // follow-up consumption window, so a late follow-up can remain queued
      // forever. Once Pi is idle, start a normal extension user turn instead.
      startingQueuedReview = true;
      reviewStartWatchdogTimer = setTimeout(() => {
        if (startingQueuedReview) clearQueuedReview();
      }, REVIEW_START_WATCHDOG_MS);
      reviewStartWatchdogTimer.unref?.();
      try {
        pi.sendUserMessage(prompt);
      } catch {
        clearQueuedReview();
      }
    };

    reviewStartTimer = setTimeout(tryStart, 0);
    reviewStartTimer.unref?.();
  }

  pi.registerFlag('no-auto-review', {
    description: 'Disable automatic post-change code review',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('auto-review', {
    description: 'Control automatic post-change code review: on, off, or status',
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === 'on') {
        enabled = true;
        ctx.ui.notify('Auto review enabled', 'info');
        return;
      }
      if (command === 'off') {
        enabled = false;
        clearQueuedReview();
        ctx.ui.notify('Auto review disabled', 'info');
        return;
      }
      if (command === '' || command === 'status') {
        const state = reviewInProgress ? 'reviewing' : reviewQueued ? 'queued' : 'idle';
        ctx.ui.notify(`Auto review is ${enabled ? 'enabled' : 'disabled'}; state: ${state}`, 'info');
        return;
      }
      ctx.ui.notify('Usage: /auto-review on | off | status', 'warning');
    },
  });

  async function getHead(signal?: AbortSignal): Promise<string> {
    const result = await pi.exec('git', ['rev-parse', '--verify', 'HEAD'], { signal });
    return result.code === 0 ? result.stdout.trim() : '';
  }

  pi.on('session_start', async (_event, ctx) => {
    enabled = pi.getFlag('no-auto-review') !== true;
    if (ctx?.hasUI && !areSkillCommandsEnabled(ctx.cwd)) {
      ctx.ui.notify('pi-auto-review uses /skill:auto-review, but enableSkillCommands is false. Set "enableSkillCommands": true in ~/.pi/agent/settings.json or .pi/settings.json.', 'warning');
    }
    clearQueuedReview();
    reviewInProgress = false;
    reviewSubagentCompleted = false;
    lastQueuedReviewFingerprint = '';
  });

  pi.on('session_shutdown', async () => {
    clearQueuedReview();
    reviewInProgress = false;
    reviewSubagentCompleted = false;
    lastQueuedReviewFingerprint = '';
  });

  pi.on('input', async (event, ctx) => {
    if (!reviewQueued && !reviewInProgress) return;
    if (event.source === 'extension' && startingQueuedReview) return;
    const state = reviewInProgress ? 'running' : 'queued';
    if (ctx.hasUI) ctx.ui.notify(`Auto review is ${state}. Please send your message after it completes.`, 'warning');
    return { action: 'handled' };
  });

  pi.on('before_agent_start', async (event) => {
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    if ((queuedReviewPrompt && prompt === queuedReviewPrompt) || (startingQueuedReview && prompt.includes(AUTO_REVIEW_PROMPT_MARKER))) {
      reviewInProgress = true;
      reviewSubagentCompleted = false;
      reviewQueued = false;
      queuedReviewPrompt = undefined;
      startingQueuedReview = false;
      if (reviewStartTimer) {
        clearTimeout(reviewStartTimer);
        reviewStartTimer = undefined;
      }
      if (reviewStartWatchdogTimer) {
        clearTimeout(reviewStartWatchdogTimer);
        reviewStartWatchdogTimer = undefined;
      }
    }
  });

  pi.on('agent_start', async (_event, ctx) => {
    sawMutationTool = false;

    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    beforeStatus = status.code === 0 ? status.stdout : '';
    beforeHead = await getHead(ctx.signal);
  });

  pi.on('tool_call', async (event) => {
    if (!reviewInProgress) return;
    if (reviewSubagentCompleted) return;

    if (event.toolName === 'subagent') {
      if (isReviewerSubagentInput(event.input)) return;
      return {
        block: true,
        reason: 'Auto review is waiting for the reviewer subagent. Do not call other subagents before the reviewer result returns.',
      };
    }

    if (event.toolName === 'bash') {
      const command = typeof event.input?.command === 'string' ? event.input.command : '';
      if (isReadOnlyReviewBashCommand(command)) return;
      return {
        block: true,
        reason: 'Auto review is read-only. Use only read-only inspection commands during the review turn.',
      };
    }

    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    return {
      block: true,
      reason: 'Auto review is read-only. Do not edit or write files during the review turn.',
    };
  });

  pi.on('tool_result', async (event) => {
    if (reviewInProgress && event.toolName === 'subagent' && !event.isError && isReviewerSubagentInput(event.input)) {
      reviewSubagentCompleted = true;
    }
    if (isFileMutationToolResult(event.toolName, event.isError)) {
      sawMutationTool = true;
    }
    if (reviewInProgress && reviewSubagentCompleted && event.toolName === 'bash' && !event.isError) {
      const command = typeof event.input?.command === 'string' ? event.input.command : '';
      if (isLikelyMutatingBashCommand(command)) sawMutationTool = true;
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    const afterStatus = status.code === 0 ? status.stdout : '';
    const afterHead = await getHead(ctx.signal);

    if (reviewInProgress) {
      reviewInProgress = false;
      reviewSubagentCompleted = false;
    }

    if (!shouldRunReview({
      enabled,
      reviewQueued,
      reviewInProgress,
      sawMutationTool,
      beforeStatus,
      afterStatus,
      beforeHead,
      afterHead,
    })) {
      return;
    }

    const changedFiles = parseChangedFiles(afterStatus);
    const committedFiles = beforeHead && afterHead && beforeHead !== afterHead
      ? await pi.exec('git', ['diff', '--name-only', '-z', `${beforeHead}..${afterHead}`], { signal: ctx.signal })
      : { stdout: '', code: 0 };
    const allChangedFiles = Array.from(new Set([
      ...changedFiles,
      ...(committedFiles.code === 0 ? committedFiles.stdout.split('\0').filter(Boolean) : []),
    ]));

    const reviewFingerprint = buildReviewFingerprint({ status: afterStatus, beforeHead, afterHead, files: allChangedFiles });
    if (reviewFingerprint === lastQueuedReviewFingerprint) return;

    const prompt = buildReviewPrompt({
      changedFiles: allChangedFiles,
      status: afterStatus,
      beforeHead,
      afterHead,
    });

    lastQueuedReviewFingerprint = reviewFingerprint;
    reviewQueued = true;
    queuedReviewPrompt = prompt;
    if (ctx.hasUI) ctx.ui.notify('Auto review queued', 'info');
    startQueuedReviewWhenIdle(ctx);
  });
}
