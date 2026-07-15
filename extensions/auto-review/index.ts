import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutoReviewConfig, ConfigKey } from './config.ts';
import { formatConfigValue, getGlobalConfigPath, getMergedConfig, getProjectConfigPath, initGlobalConfig, initProjectConfig, isValidConfigKey, parseConfigValue, readGlobalConfig, readProjectConfig, writeGlobalConfig, writeProjectConfig } from './config.ts';
import { CURRENT_WORKTREE_PATHSPECS, areSkillCommandsEnabled, buildReviewPrompt, filterCurrentWorktreeStatus, isAutoReviewFixerSubagentInput, isCurrentWorktreeReviewFile, isFileMutationToolResult, isLikelyMutatingBashCommand, parseChangedFiles, shouldRunReview, splitSimpleCommand } from './helpers.ts';

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
  let reviewCwd = '';
  let reviewCwdLocked = false;
  let lastQueuedReviewFingerprint = '';
  let queuedReviewPrompt: string | undefined;
  let reviewStartTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewStartWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let startingQueuedReview = false;

  function resolveEnabledState(): { enabled: boolean; source: string } {
    if (pi.getFlag('no-auto-review') === true) return { enabled: false, source: 'disabled (--no-auto-review flag)' };
    if (runtimeEnabledOverride === true) return { enabled: true, source: 'enabled (session: /auto-review on)' };
    if (runtimeEnabledOverride === false) return { enabled: false, source: 'disabled (session: /auto-review off)' };
    const cfg = config?.enabled;
    if (cfg === false) return { enabled: false, source: 'disabled (config: enabled=false)' };
    if (cfg === true) return { enabled: true, source: 'enabled (config: enabled=true)' };
    // ponytail: pre-session-start defensive guard. session_start always loads config before commands run,
    // so this branch is unreachable in production; kept as a safe fallback if resolveEnabledState is ever
    // called before session_start. Upgrade path: remove if config initialization is guaranteed at construction.
    return { enabled: true, source: 'enabled (default)' };
  }

  function isEnabled(): boolean {
    return resolveEnabledState().enabled;
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
        const projectRoots = await resolveProjectConfigRoots(ctx.cwd, ctx.signal);

        if (sub.action === 'show') {
          const merged = getMergedConfig(ctx.cwd, undefined, projectRoots);
          const globalConfig = readGlobalConfig();
          const project = readProjectConfig(ctx.cwd, projectRoots);
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
          const source = sub.scope === 'global' ? readGlobalConfig() : sub.scope === 'project' ? readProjectConfig(ctx.cwd, projectRoots) : getMergedConfig(ctx.cwd, undefined, projectRoots);
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
            config = getMergedConfig(ctx.cwd, undefined, projectRoots);
            // Setting `enabled` via config is an explicit persistent intent; clear any
            // session-only runtime override so the new value actually takes effect.
            // Without this, a prior `/auto-review on|off` would shadow `config set enabled`.
            if (sub.key === 'enabled') runtimeEnabledOverride = undefined;
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
            config = getMergedConfig(ctx.cwd, undefined, projectRoots);
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
        const { enabled, source } = resolveEnabledState();
        ctx.ui.notify(`Auto review is ${enabled ? 'enabled' : 'disabled'}; ${source}; state: ${formatRuntimeState()}`, 'info');
        return;
      }
      ctx.ui.notify('Usage: /auto-review on | off | status | config', 'warning');
    },
  });

  function formatGitOutput(result: { stdout: string; stderr?: string; code: number }): string {
    return result.code === 0 ? result.stdout : `${result.code}:${result.stderr ?? ''}`;
  }

  function gitArgs(cwd: string, args: string[]): string[] {
    return ['-C', cwd, ...args];
  }

  async function getHead(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await pi.exec('git', gitArgs(cwd, ['rev-parse', '--verify', 'HEAD']), { signal });
    return result.code === 0 ? result.stdout.trim() : '';
  }

  async function getWorktreeRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await pi.exec('git', gitArgs(cwd, ['rev-parse', '--show-toplevel']), { signal });
    const root = result.code === 0 ? result.stdout.trim() : '';
    return path.isAbsolute(root) ? root : cwd;
  }

  // Find the main repo root via git common-dir. Linked worktrees can live anywhere
  // on the filesystem (not necessarily nested under the main repo), so filesystem
  // walk-up alone can't find .pi/ in the main repo when .pi/ is gitignored.
  // git rev-parse --git-common-dir returns the shared .git dir; its parent is the
  // main repo root. Returns [] on failure (walk-up in config.ts is the fallback).
  async function resolveProjectConfigRoots(cwd: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const result = await pi.exec('git', gitArgs(cwd, ['rev-parse', '--git-common-dir']), { signal });
      if (!result || result.code !== 0) return [];
      const commonDir = result.stdout.trim();
      if (!commonDir) return [];
      const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
      const mainRoot = path.dirname(absolute);
      return mainRoot && mainRoot !== cwd ? [mainRoot] : [];
    } catch {
      return [];
    }
  }

  function getInputCwd(input: Record<string, unknown> | undefined): string | undefined {
    return typeof input?.cwd === 'string' && input.cwd.trim().length > 0 ? input.cwd.trim() : undefined;
  }

  function getInputPath(input: Record<string, unknown> | undefined): string | undefined {
    return typeof input?.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : undefined;
  }

  function resolveAgainstCtxCwd(ctxCwd: string, cwd: string | undefined): string {
    return path.resolve(ctxCwd, cwd ?? '.');
  }

  function findExistingDirectory(startDir: string, fallback: string): string {
    let current = startDir;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return fallback;
      try {
        if (fs.existsSync(current) && fs.statSync(current).isDirectory()) return current;
      } catch {
        // Keep walking upward; this is only a best-effort pre-mutation probe.
      }
      current = parent;
    }
  }

  function resetReviewScope(): void {
    reviewCwd = '';
    reviewCwdLocked = false;
    lastQueuedReviewFingerprint = '';
  }

  function resolveFileProbeCwd(input: Record<string, unknown> | undefined, ctxCwd: string): string {
    const file = getInputPath(input);
    const base = resolveAgainstCtxCwd(ctxCwd, getInputCwd(input));
    if (!file) return base;
    return findExistingDirectory(path.dirname(path.resolve(base, file)), ctxCwd);
  }

  function extractGitCPath(command: string, ctxCwd: string): string | undefined {
    const tokens = splitSimpleCommand(command.trim());
    if (tokens[0] !== 'git') return undefined;

    let resolvedCwd: string | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (token === '-C') {
        const gitCwd = tokens[index + 1];
        if (!gitCwd) return resolvedCwd;
        resolvedCwd = path.resolve(resolvedCwd ?? ctxCwd, gitCwd);
        index += 1;
        continue;
      }
      if (token === '-c' || token === '--git-dir' || token === '--work-tree') {
        index += 1;
        continue;
      }
      if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) continue;
      return resolvedCwd;
    }

    return resolvedCwd;
  }

  async function captureReviewBaseline(cwd: string, signal?: AbortSignal, options: { resolveRoot?: boolean } = {}): Promise<void> {
    reviewCwd = options.resolveRoot === true ? await getWorktreeRoot(cwd, signal) : cwd;
    beforeStatus = await getStatus(reviewCwd, signal);
    beforeHead = await getHead(reviewCwd, signal);
  }

  async function lockReviewCwd(cwd: string, signal?: AbortSignal): Promise<void> {
    if (reviewCwdLocked) return;
    await captureReviewBaseline(cwd, signal, { resolveRoot: true });
    reviewCwdLocked = true;
  }

  // ponytail: silent fallback is deliberate best-effort (the `safe` prefix signals it).
  // Ceiling: git failures become invisible — review may run against ctxCwd with no diagnostic.
  // Upgrade path: thread ctx.ui.notify or a logger call into the catch blocks when git-failure
  // diagnosability is needed.
  async function safeLockReviewCwd(cwd: string, ctxCwd: string, signal?: AbortSignal): Promise<void> {
    try {
      await lockReviewCwd(cwd, signal);
    } catch {
      try {
        await captureReviewBaseline(ctxCwd, signal);
      } catch {
        reviewCwd = ctxCwd;
      }
      reviewCwdLocked = true;
    }
  }

  async function getStatus(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await pi.exec('git', gitArgs(cwd, ['status', '--porcelain', '--', ...CURRENT_WORKTREE_PATHSPECS]), { signal });
    return result.code === 0 ? filterCurrentWorktreeStatus(result.stdout) : '';
  }

  async function getWorktreeDiff(cwd: string, signal?: AbortSignal): Promise<string> {
    return formatGitOutput(await pi.exec('git', gitArgs(cwd, ['diff', '--no-ext-diff', '--', ...CURRENT_WORKTREE_PATHSPECS]), { signal }));
  }

  async function getCachedDiff(cwd: string, signal?: AbortSignal): Promise<string> {
    return formatGitOutput(await pi.exec('git', gitArgs(cwd, ['diff', '--cached', '--no-ext-diff', '--', ...CURRENT_WORKTREE_PATHSPECS]), { signal }));
  }

  function hasUntrackedFiles(status: string): boolean {
    return status.split('\n').some((line) => line.startsWith('?? '));
  }

  async function getUntrackedFileSnapshot(cwd: string, signal?: AbortSignal): Promise<string> {
    const listed = await pi.exec('git', gitArgs(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...CURRENT_WORKTREE_PATHSPECS]), { signal });
    if (listed.code !== 0) return `${listed.code}:${listed.stderr ?? ''}`;

    const files = listed.stdout.split('\0').filter(Boolean).sort();
    if (files.length === 0) return '';

    const entries: Array<[string, string]> = [];
    const chunkSize = 100;
    for (let index = 0; index < files.length; index += chunkSize) {
      const chunk = files.slice(index, index + chunkSize);
      const hashed = await pi.exec('git', gitArgs(cwd, ['hash-object', '--', ...chunk]), { signal });
      if (hashed.code !== 0) return JSON.stringify({ files, error: `${hashed.code}:${hashed.stderr ?? ''}` });
      const hashes = hashed.stdout.split('\n').filter(Boolean);
      for (let offset = 0; offset < chunk.length; offset += 1) {
        entries.push([chunk[offset] ?? '', hashes[offset] ?? '']);
      }
    }

    return JSON.stringify(entries);
  }

  pi.on('session_start', async (_event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const projectRoots = await resolveProjectConfigRoots(cwd).catch(() => []);
    config = getMergedConfig(cwd, undefined, projectRoots);
    runtimeEnabledOverride = undefined;
    if (ctx?.hasUI && !areSkillCommandsEnabled(ctx.cwd)) {
      ctx.ui.notify('pi-auto-review uses /skill:auto-review, but enableSkillCommands is false. Set "enableSkillCommands": true in ~/.pi/agent/settings.json or .pi/settings.json.', 'warning');
    }
    clearQueuedReview();
    reviewPassCount = 0;
    resetReviewScope();
  });

  pi.on('session_shutdown', async () => {
    clearQueuedReview();
    reviewPassCount = 0;
    resetReviewScope();
  });

  pi.on('input', async (event, ctx) => {
    if (!reviewQueued) {
      if (event.source !== 'extension') {
        reviewPassCount = 0;
        resetReviewScope();
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
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : undefined;

    if (event.toolName === 'edit' || event.toolName === 'write') {
      const file = getInputPath(input);
      if (file) await safeLockReviewCwd(resolveFileProbeCwd(input, ctx.cwd), ctx.cwd, ctx.signal);
      return;
    }

    if (event.toolName === 'bash') {
      const command = typeof input?.command === 'string' ? input.command : '';
      if (isLikelyMutatingBashCommand(command)) {
        const gitCPath = extractGitCPath(command, ctx.cwd);
        const cwd = gitCPath ?? resolveAgainstCtxCwd(ctx.cwd, getInputCwd(input));
        await safeLockReviewCwd(cwd, ctx.cwd, ctx.signal);
      }
      return;
    }

    if (event.toolName !== 'subagent') return;

    // Extension-level safety net: strip disabled reviewer profiles from parallel
    // task fanout. The skill helper filters them before fanout, but this catches
    // manual /skill:auto-review turns where config was resolved differently and
    // LLM hallucination. Match by the task label the skill requires at task start.
    if (Array.isArray(input?.tasks) && config) {
      const disabledLabels = config.reviewerProfiles
        .filter((p) => p.enabled === false)
        .map((p) => ({ label: p.label ?? `[auto-review:profile:${p.id}]`, custom: Boolean(p.label) }));
      if (disabledLabels.length > 0) {
        input.tasks = (input.tasks as unknown[]).filter((task) => {
          const taskText = task && typeof task === 'object' && typeof (task as { task?: unknown }).task === 'string'
            ? (task as { task: string }).task
            : '';
          const firstLine = taskText.split('\n', 1)[0] ?? '';
          return !disabledLabels.some(({ label, custom }) => custom ? firstLine === label : taskText.startsWith(label));
        });
      }
    }

    if (!isAutoReviewFixerSubagentInput(input, config?.fixerAgent ?? 'worker')) return;
    await safeLockReviewCwd(resolveAgainstCtxCwd(ctx.cwd, getInputCwd(input)), ctx.cwd, ctx.signal);
    if (capturedFixerDiffSnapshot) return;

    try {
      beforeFixerWorktreeDiff = await getWorktreeDiff(reviewCwd, ctx.signal);
      beforeFixerCachedDiff = await getCachedDiff(reviewCwd, ctx.signal);
      beforeFixerUntrackedSnapshot = await getUntrackedFileSnapshot(reviewCwd, ctx.signal);
      capturedFixerDiffSnapshot = true;
    } catch {
      beforeFixerWorktreeDiff = '';
      beforeFixerCachedDiff = '';
      beforeFixerUntrackedSnapshot = '';
      capturedFixerDiffSnapshot = false;
    }
  });

  pi.on('agent_start', async (_event, ctx) => {
    sawMutationTool = false;
    sawFixerSubagent = false;
    capturedFixerDiffSnapshot = false;
    beforeFixerWorktreeDiff = '';
    beforeFixerCachedDiff = '';
    beforeFixerUntrackedSnapshot = '';
    reviewCwd = '';
    reviewCwdLocked = false;

    await captureReviewBaseline(ctx.cwd, ctx.signal);
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
    // ponytail: best-effort review trigger. If git inspection fails, the review is silently skipped.
    // Ceiling: subprocess failures become invisible. Upgrade path: ctx.ui.notify when diagnosability is needed.
    try {
      // Reload config so direct file edits (including in worktrees where .pi/ is gitignored)
      // take effect on the next agent turn without requiring /auto-review config set.
      // Use git common-dir to find the main repo root for linked worktrees that live
      // outside the main repo directory tree.
      const projectRoots = await resolveProjectConfigRoots(ctx.cwd, ctx.signal);
      config = getMergedConfig(ctx.cwd, undefined, projectRoots);
      const effectiveReviewCwd = reviewCwd || await getWorktreeRoot(ctx.cwd, ctx.signal);
      const [afterStatus, afterHead] = await Promise.all([
        getStatus(effectiveReviewCwd, ctx.signal),
        getHead(effectiveReviewCwd, ctx.signal),
      ]);
      let worktreeDiff: string | undefined;
      let cachedDiff: string | undefined;
      let untrackedSnapshot: string | undefined;

      if (capturedFixerDiffSnapshot) {
        [worktreeDiff, cachedDiff, untrackedSnapshot] = await Promise.all([
          getWorktreeDiff(effectiveReviewCwd, ctx.signal),
          getCachedDiff(effectiveReviewCwd, ctx.signal),
          getUntrackedFileSnapshot(effectiveReviewCwd, ctx.signal),
        ]);
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
        ? await pi.exec('git', gitArgs(effectiveReviewCwd, ['diff', '--name-only', '-z', `${beforeHead}..${afterHead}`, '--', ...CURRENT_WORKTREE_PATHSPECS]), { signal: ctx.signal })
        : { stdout: '', code: 0 };
      const allChangedFiles = Array.from(new Set([
        ...changedFiles,
        ...(committedFiles.code === 0 ? committedFiles.stdout.split('\0').filter((file) => file.length > 0 && isCurrentWorktreeReviewFile(file)) : []),
      ]));
      if (allChangedFiles.length === 0) return;

      worktreeDiff ??= await getWorktreeDiff(effectiveReviewCwd, ctx.signal);
      cachedDiff ??= await getCachedDiff(effectiveReviewCwd, ctx.signal);
      if (untrackedSnapshot === undefined && hasUntrackedFiles(afterStatus)) {
        untrackedSnapshot = await getUntrackedFileSnapshot(effectiveReviewCwd, ctx.signal);
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
        status: afterStatus,
        beforeHead,
        afterHead,
        reviewCwd: effectiveReviewCwd !== ctx.cwd ? effectiveReviewCwd : undefined,
      });

      lastQueuedReviewFingerprint = reviewFingerprint;
      reviewQueued = true;
      queuedReviewPrompt = prompt;
      queuedReviewPass = reviewPassCount + 1;
      if (ctx.hasUI) ctx.ui.notify(`Auto review queued (pass ${queuedReviewPass})`, 'info');
      startQueuedReviewWhenIdle(ctx);
    } catch {
      // Best-effort: if git inspection fails, skip this review trigger silently.
    }
  });
}
