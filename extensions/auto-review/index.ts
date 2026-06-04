import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutoReviewConfig, ConfigKey } from './config.ts';
import { formatConfigValue, getGlobalConfigPath, getMergedConfig, getProjectConfigPath, initGlobalConfig, initProjectConfig, isValidConfigKey, parseConfigValue, readGlobalConfig, readProjectConfig, writeGlobalConfig, writeProjectConfig } from './config.ts';
import { areSkillCommandsEnabled, buildReviewPrompt, isAutoReviewFixerSubagentInput, isFileMutationToolResult, isLikelyMutatingBashCommand, parseChangedFiles, shouldRunReview } from './helpers.ts';

export default function autoReviewExtension(pi: ExtensionAPI) {
  // pi-subagents launches child agents as separate Pi processes. User/project
  // packages may still load there, so disable this extension in subagent
  // children to avoid a child fixer queuing another auto-review turn and
  // recursively spawning more reviewers/fixers.
  if (process.env.PI_SUBAGENT_CHILD === '1') return;

  let config: Required<AutoReviewConfig> | undefined;
  let runtimeEnabledOverride: boolean | undefined;
  let reviewQueued = false;
  let reviewPassCount = 0;
  let queuedReviewPass = 0;
  let sawMutationTool = false;
  let sawFixerSubagent = false;
  let capturedFixerDiffSnapshot = false;
  let beforeStatus = '';
  let beforeHead = '';
  let beforeFixerWorktreeDiff = '';
  let beforeFixerCachedDiff = '';
  let beforeFixerUntrackedSnapshot = '';
  let lastQueuedReviewFingerprint = '';
  let queuedReviewPrompt: string | undefined;
  let reviewStartTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewStartWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let startingQueuedReview = false;

  function isEnabled(): boolean {
    if (pi.getFlag('no-auto-review') === true) return false;
    if (typeof runtimeEnabledOverride === 'boolean') return runtimeEnabledOverride;
    return config?.enabled ?? true;
  }

  function formatRuntimeState(): string {
    const state = reviewQueued ? 'queued' : 'idle';
    if (reviewQueued) return `${state}; pass: ${queuedReviewPass}`;
    if (reviewPassCount > 0) return `${state}; completed passes: ${reviewPassCount}`;
    return state;
  }

  function clearQueuedReview(options: { clearFingerprint?: boolean } = { clearFingerprint: true }): void {
    reviewQueued = false;
    queuedReviewPrompt = undefined;
    queuedReviewPass = 0;
    startingQueuedReview = false;
    if (options.clearFingerprint !== false) lastQueuedReviewFingerprint = '';
    if (reviewStartTimer) {
      clearTimeout(reviewStartTimer);
      reviewStartTimer = undefined;
    }
    if (reviewStartWatchdogTimer) {
      clearTimeout(reviewStartWatchdogTimer);
      reviewStartWatchdogTimer = undefined;
    }
  }

  function hashReviewContent(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  function buildReviewFingerprint(input: { status: string; beforeHead: string; afterHead: string; files: string[]; worktreeDiff: string; cachedDiff: string; untrackedSnapshot: string }): string {
    return JSON.stringify({
      status: input.status.trim(),
      beforeHead: input.beforeHead.trim(),
      afterHead: input.afterHead.trim(),
      files: [...input.files].sort(),
      worktreeDiffHash: hashReviewContent(input.worktreeDiff),
      cachedDiffHash: hashReviewContent(input.cachedDiff),
      untrackedSnapshotHash: hashReviewContent(input.untrackedSnapshot),
    });
  }

  function startQueuedReviewWhenIdle(ctx: ExtensionContext): void {
    if (startingQueuedReview || reviewStartTimer) return;

    const watchdogMs = config?.reviewStartWatchdogMs ?? 30_000;
    reviewStartWatchdogTimer = setTimeout(() => {
      clearQueuedReview();
    }, watchdogMs);
    reviewStartWatchdogTimer.unref?.();

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
      try {
        pi.sendUserMessage(prompt);
        reviewPassCount = queuedReviewPass;
        clearQueuedReview({ clearFingerprint: false });
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

  type ConfigReadScope = 'effective' | 'global' | 'project';
  type ConfigWriteScope = 'global' | 'project';
  type ConfigSubcommand =
    | { action: 'show'; scope: ConfigReadScope }
    | { action: 'get'; scope: ConfigReadScope; key: ConfigKey }
    | { action: 'set'; scope: ConfigWriteScope; key: ConfigKey; value: string }
    | { action: 'init'; scope: ConfigWriteScope }
    | { action: 'help' };

  function parseConfigScope(args: string[]): { scope: ConfigReadScope; rest: string[] } | undefined {
    if (args[1] === '--global') return { scope: 'global', rest: [args[0]!, ...args.slice(2)] };
    if (args[1] === '--project') return { scope: 'project', rest: [args[0]!, ...args.slice(2)] };
    if (args[1] === '--scope') {
      if (args[2] === 'global' || args[2] === 'project') return { scope: args[2], rest: [args[0]!, ...args.slice(3)] };
      return undefined;
    }
    return { scope: 'effective', rest: args };
  }

  function parseConfigSubcommand(raw: string): ConfigSubcommand {
    const args = raw.trim().split(/\s+/).filter(Boolean);
    const scoped = parseConfigScope(args);
    if (!scoped) return { action: 'help' };
    const { scope, rest } = scoped;
    if (rest.length === 1 && rest[0] === 'config') return { action: 'show', scope };
    if (rest.length === 3 && rest[0] === 'config' && rest[1] === 'get' && isValidConfigKey(rest[2])) return { action: 'get', scope, key: rest[2] };
    if (rest.length >= 4 && rest[0] === 'config' && rest[1] === 'set' && isValidConfigKey(rest[2])) return { action: 'set', scope: scope === 'global' ? 'global' : 'project', key: rest[2], value: rest.slice(3).join(' ') };
    if (rest.length === 2 && rest[0] === 'config' && rest[1] === 'init') return { action: 'init', scope: scope === 'global' ? 'global' : 'project' };
    return { action: 'help' };
  }

  pi.registerCommand('auto-review', {
    description: 'Control automatic post-change code review: on, off, status, or config',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const command = trimmed.toLowerCase();

      // Config subcommand (preserve original case for config keys)
      if (command.startsWith('config')) {
        const sub = parseConfigSubcommand(trimmed);

        if (sub.action === 'show') {
          const merged = getMergedConfig(ctx.cwd);
          const globalConfig = readGlobalConfig();
          const project = readProjectConfig(ctx.cwd);
          const lines = sub.scope === 'global'
            ? [
                'Auto review global configuration:',
                `Global file: ${getGlobalConfigPath()}`,
                'Global settings:',
                ...Object.entries(globalConfig).map(([k, v]) => `  ${k}: ${formatConfigValue(v)}`),
              ]
            : sub.scope === 'project'
              ? [
                  'Auto review project configuration:',
                  `Project file: ${getProjectConfigPath(ctx.cwd)}`,
                  'Project overrides:',
                  ...Object.entries(project).map(([k, v]) => `  ${k}: ${formatConfigValue(v)}`),
                ]
              : [
                  'Auto review configuration:',
                  `Global file: ${getGlobalConfigPath()}`,
                  `Project file: ${getProjectConfigPath(ctx.cwd)}`,
                  'Global settings:',
                  ...Object.entries(globalConfig).map(([k, v]) => `  ${k}: ${formatConfigValue(v)}`),
                  'Project overrides:',
                  ...Object.entries(project).map(([k, v]) => `  ${k}: ${formatConfigValue(v)}`),
                  'Effective settings:',
                  ...Object.entries(merged).map(([k, v]) => `  ${k}: ${formatConfigValue(v)}`),
                ];
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }

        if (sub.action === 'get') {
          const source = sub.scope === 'global' ? readGlobalConfig() : sub.scope === 'project' ? readProjectConfig(ctx.cwd) : getMergedConfig(ctx.cwd);
          ctx.ui.notify(`${sub.key}: ${formatConfigValue(source[sub.key])}`, 'info');
          return;
        }

        if (sub.action === 'set') {
          try {
            const parsed = parseConfigValue(sub.key, sub.value);
            const patch: Partial<AutoReviewConfig> = { [sub.key]: parsed };
            if (sub.scope === 'global') writeGlobalConfig(patch as AutoReviewConfig);
            else writeProjectConfig(ctx.cwd, patch as AutoReviewConfig);
            // Reload config into the active session
            config = getMergedConfig(ctx.cwd);
            const scopeSuffix = sub.scope === 'global' ? ' (global)' : '';
            ctx.ui.notify(`Set ${sub.key} = ${formatConfigValue(parsed)}${scopeSuffix}`, 'info');
          } catch (err) {
            ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
          }
          return;
        }

        if (sub.action === 'init') {
          try {
            if (sub.scope === 'global') {
              initGlobalConfig();
              ctx.ui.notify(`Created global config at ${getGlobalConfigPath()}`, 'info');
            } else {
              initProjectConfig(ctx.cwd);
              ctx.ui.notify(`Created project config at ${getProjectConfigPath(ctx.cwd)}`, 'info');
            }
            config = getMergedConfig(ctx.cwd);
          } catch (err) {
            ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
          }
          return;
        }

        ctx.ui.notify(
          'Usage:\n  /auto-review config [--global|--project|--scope global|--scope project]\n  /auto-review config [--global|--project|--scope global|--scope project] get <key>\n  /auto-review config [--global|--project|--scope global|--scope project] set <key> <value>\n  /auto-review config [--global|--project|--scope global|--scope project] init',
          'warning',
        );
        return;
      }

      if (command === 'on') {
        runtimeEnabledOverride = true;
        if (pi.getFlag('no-auto-review') === true) {
          ctx.ui.notify('Auto review remains disabled because Pi was started with --no-auto-review', 'warning');
        } else {
          ctx.ui.notify('Auto review enabled', 'info');
        }
        return;
      }
      if (command === 'off') {
        runtimeEnabledOverride = false;
        reviewPassCount = 0;
        clearQueuedReview();
        ctx.ui.notify('Auto review disabled', 'info');
        return;
      }
      if (command === '' || command === 'status') {
        ctx.ui.notify(`Auto review is ${isEnabled() ? 'enabled' : 'disabled'}; state: ${formatRuntimeState()}`, 'info');
        return;
      }
      ctx.ui.notify('Usage: /auto-review on | off | status | config', 'warning');
    },
  });

  function formatGitOutput(result: { stdout: string; stderr?: string; code: number }): string {
    return result.code === 0 ? result.stdout : `${result.code}:${result.stderr ?? ''}`;
  }

  async function getHead(signal?: AbortSignal): Promise<string> {
    const result = await pi.exec('git', ['rev-parse', '--verify', 'HEAD'], { signal });
    return result.code === 0 ? result.stdout.trim() : '';
  }

  async function getWorktreeDiff(signal?: AbortSignal): Promise<string> {
    return formatGitOutput(await pi.exec('git', ['diff', '--no-ext-diff'], { signal }));
  }

  async function getCachedDiff(signal?: AbortSignal): Promise<string> {
    return formatGitOutput(await pi.exec('git', ['diff', '--cached', '--no-ext-diff'], { signal }));
  }

  function hasUntrackedFiles(status: string): boolean {
    return status.split('\n').some((line) => line.startsWith('?? '));
  }

  async function getUntrackedFileSnapshot(signal?: AbortSignal): Promise<string> {
    const listed = await pi.exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { signal });
    if (listed.code !== 0) return `${listed.code}:${listed.stderr ?? ''}`;

    const files = listed.stdout.split('\0').filter(Boolean).sort();
    if (files.length === 0) return '';

    const entries: Array<[string, string]> = [];
    const chunkSize = 100;
    for (let index = 0; index < files.length; index += chunkSize) {
      const chunk = files.slice(index, index + chunkSize);
      const hashed = await pi.exec('git', ['hash-object', '--', ...chunk], { signal });
      if (hashed.code !== 0) return JSON.stringify({ files, error: `${hashed.code}:${hashed.stderr ?? ''}` });
      const hashes = hashed.stdout.split('\n').filter(Boolean);
      for (let offset = 0; offset < chunk.length; offset += 1) {
        entries.push([chunk[offset] ?? '', hashes[offset] ?? '']);
      }
    }

    return JSON.stringify(entries);
  }

  pi.on('session_start', async (_event, ctx) => {
    config = getMergedConfig(ctx?.cwd ?? process.cwd());
    runtimeEnabledOverride = undefined;
    if (ctx?.hasUI && !areSkillCommandsEnabled(ctx.cwd)) {
      ctx.ui.notify('pi-auto-review uses /skill:auto-review, but enableSkillCommands is false. Set "enableSkillCommands": true in ~/.pi/agent/settings.json or .pi/settings.json.', 'warning');
    }
    clearQueuedReview();
    reviewPassCount = 0;
    lastQueuedReviewFingerprint = '';
  });

  pi.on('session_shutdown', async () => {
    clearQueuedReview();
    reviewPassCount = 0;
    lastQueuedReviewFingerprint = '';
  });

  pi.on('input', async (event, ctx) => {
    if (!reviewQueued) {
      if (event.source !== 'extension') {
        reviewPassCount = 0;
        lastQueuedReviewFingerprint = '';
      }
      return;
    }
    if (event.source === 'extension' && startingQueuedReview) return;
    const blockInput = config?.blockInputDuringReview ?? true;
    if (!blockInput) return;
    if (ctx.hasUI) ctx.ui.notify('Auto review is queued. Please send your message after it starts or press Esc to interrupt.', 'warning');
    return { action: 'handled' };
  });

  pi.on('before_agent_start', async () => {
    // Intentionally no-op: auto-review now trusts the skill/subagent workflow
    // instead of detecting and guarding a special marker-bearing turn.
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'subagent') return;
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : undefined;
    if (!isAutoReviewFixerSubagentInput(input, config?.fixerAgent ?? 'worker')) return;
    if (capturedFixerDiffSnapshot) return;

    beforeFixerWorktreeDiff = await getWorktreeDiff(ctx.signal);
    beforeFixerCachedDiff = await getCachedDiff(ctx.signal);
    beforeFixerUntrackedSnapshot = await getUntrackedFileSnapshot(ctx.signal);
    capturedFixerDiffSnapshot = true;
  });

  pi.on('agent_start', async (_event, ctx) => {
    sawMutationTool = false;
    sawFixerSubagent = false;
    capturedFixerDiffSnapshot = false;
    beforeFixerWorktreeDiff = '';
    beforeFixerCachedDiff = '';
    beforeFixerUntrackedSnapshot = '';

    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    beforeStatus = status.code === 0 ? status.stdout : '';
    beforeHead = await getHead(ctx.signal);
  });

  pi.on('tool_result', async (event) => {
    if (isFileMutationToolResult(event.toolName, event.isError)) {
      sawMutationTool = true;
    }
    if (event.toolName === 'bash' && !event.isError) {
      const command = typeof event.input?.command === 'string' ? event.input.command : '';
      if (isLikelyMutatingBashCommand(command)) sawMutationTool = true;
    }
    if (event.toolName === 'subagent') {
      const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : undefined;
      if (isAutoReviewFixerSubagentInput(input, config?.fixerAgent ?? 'worker')) sawFixerSubagent = true;
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    const status = await pi.exec('git', ['status', '--porcelain'], { signal: ctx.signal });
    const afterStatus = status.code === 0 ? status.stdout : '';
    const afterHead = await getHead(ctx.signal);
    let worktreeDiff: string | undefined;
    let cachedDiff: string | undefined;
    let untrackedSnapshot: string | undefined;

    if (capturedFixerDiffSnapshot) {
      worktreeDiff = await getWorktreeDiff(ctx.signal);
      cachedDiff = await getCachedDiff(ctx.signal);
      untrackedSnapshot = await getUntrackedFileSnapshot(ctx.signal);
    }

    const fixerChangedGitState = sawFixerSubagent && (
      beforeStatus.trim() !== afterStatus.trim()
      || beforeHead.trim() !== afterHead.trim()
      || (capturedFixerDiffSnapshot && (
        beforeFixerWorktreeDiff !== (worktreeDiff ?? '')
        || beforeFixerCachedDiff !== (cachedDiff ?? '')
        || beforeFixerUntrackedSnapshot !== (untrackedSnapshot ?? '')
      ))
    );

    if (!shouldRunReview({
      enabled: isEnabled(),
      reviewQueued,
      reviewInProgress: false,
      sawMutationTool: sawMutationTool || fixerChangedGitState,
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

    worktreeDiff ??= await getWorktreeDiff(ctx.signal);
    cachedDiff ??= await getCachedDiff(ctx.signal);
    if (untrackedSnapshot === undefined && hasUntrackedFiles(afterStatus)) {
      untrackedSnapshot = await getUntrackedFileSnapshot(ctx.signal);
    }
    const reviewFingerprint = buildReviewFingerprint({
      status: afterStatus,
      beforeHead,
      afterHead,
      files: allChangedFiles,
      worktreeDiff,
      cachedDiff,
      untrackedSnapshot: untrackedSnapshot ?? '',
    });
    if (reviewFingerprint === lastQueuedReviewFingerprint) return;

    const maxReviewPasses = config?.maxReviewPasses ?? null;
    if (maxReviewPasses !== null && reviewPassCount >= maxReviewPasses) {
      if (ctx.hasUI) ctx.ui.notify(`Auto review stopped after ${reviewPassCount} pass(es); maxReviewPasses is ${maxReviewPasses}.`, 'info');
      return;
    }

    const prompt = buildReviewPrompt({
      changedFiles: allChangedFiles,
      status: afterStatus,
      beforeHead,
      afterHead,
    });

    lastQueuedReviewFingerprint = reviewFingerprint;
    reviewQueued = true;
    queuedReviewPrompt = prompt;
    queuedReviewPass = reviewPassCount + 1;
    if (ctx.hasUI) ctx.ui.notify(`Auto review queued (pass ${queuedReviewPass})`, 'info');
    startQueuedReviewWhenIdle(ctx);
  });
}
