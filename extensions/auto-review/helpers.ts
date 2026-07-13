import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AutoReviewConfig } from './config.ts';

export interface ReviewDecisionInput {
  enabled: boolean;
  reviewQueued: boolean;
  reviewInProgress: boolean;
  sawMutationTool: boolean;
  beforeStatus: string;
  afterStatus: string;
  beforeHead?: string;
  afterHead?: string;
}

export interface ReviewPromptInput {
  status: string;
  beforeHead?: string;
  afterHead?: string;
  reviewCwd?: string;
  /** Merged effective config; when provided, profiles with enabled:false are filtered in code and the block is passed inline so the skill does not re-read files. */
  effectiveConfig?: Required<AutoReviewConfig>;
}

export const AUTO_REVIEW_SKILL_COMMAND = '/skill:auto-review';
export const CURRENT_WORKTREE_PATHSPECS = [':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'];

const READ_ONLY_REVIEW_COMMANDS = new Set(['pwd', 'ls', 'grep', 'rg', 'cat', 'head', 'tail', 'wc']);

function readEnableSkillCommandsSetting(filePath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = (parsed as { enableSkillCommands?: unknown }).enableSkillCommands;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function areSkillCommandsEnabled(cwd: string, homeDir = os.homedir()): boolean {
  let enabled = true;
  const globalSetting = readEnableSkillCommandsSetting(path.join(homeDir, '.pi', 'agent', 'settings.json'));
  if (typeof globalSetting === 'boolean') enabled = globalSetting;
  const projectSetting = readEnableSkillCommandsSetting(path.join(cwd, '.pi', 'settings.json'));
  if (typeof projectSetting === 'boolean') enabled = projectSetting;
  return enabled;
}

export function isFileMutationToolResult(toolName: string, isError: boolean | undefined): boolean {
  if (isError) return false;
  return toolName === 'edit' || toolName === 'write';
}

function isSubagentTaskForAgent(value: unknown, agentName: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const task = value as { agent?: unknown; tasks?: unknown; chain?: unknown; parallel?: unknown };
  if (task.agent === agentName) return true;
  if (Array.isArray(task.tasks)) return task.tasks.some((t) => isSubagentTaskForAgent(t, agentName));
  if (Array.isArray(task.parallel)) return task.parallel.some((t) => isSubagentTaskForAgent(t, agentName));
  if (Array.isArray(task.chain)) return task.chain.some((t) => isSubagentTaskForAgent(t, agentName));
  return false;
}

function isReviewerTask(value: unknown, reviewerAgent = 'reviewer'): boolean {
  if (!value || typeof value !== 'object') return false;
  const task = value as { agent?: unknown; tasks?: unknown };
  if (task.agent === reviewerAgent) return true;
  if (Array.isArray(task.tasks)) return task.tasks.length > 0 && task.tasks.every((t) => isReviewerTask(t, reviewerAgent));
  return false;
}

export function isReviewerSubagentInput(input: Record<string, unknown> | undefined, reviewerAgent = 'reviewer'): boolean {
  if (!input) return false;
  if (input.agent === reviewerAgent) return true;
  if (Array.isArray(input.tasks)) return input.tasks.length > 0 && input.tasks.every((t) => isReviewerTask(t, reviewerAgent));
  return false;
}

export function isAutoReviewFixerSubagentInput(input: Record<string, unknown> | undefined, fixerAgent = 'worker'): boolean {
  if (!input || !fixerAgent) return false;
  return isSubagentTaskForAgent(input, fixerAgent);
}

export function isLikelyMutatingBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (hasShellMetaOutsideQuotes(trimmed, (char, quote) => quote === undefined && /[><;&|]/.test(char))) return true;

  const tokens = splitSimpleCommand(trimmed);
  const [binary = ''] = tokens;
  if (['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'ln', 'chmod', 'chown', 'tee'].includes(binary)) return true;
  if (binary === 'sed' && /(?:^|\s)(?:--in-place(?:=\S*)?|-i(?:\S*|\s|$))/.test(trimmed)) return true;
  if (binary === 'find' && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls|chmod|chown)\b/.test(trimmed)) return true;
  if (binary === 'git') {
    const git = parseGitCommand(tokens);
    if (!git) return false;
    if (git.subcommand === 'branch') return !isReadOnlyGitBranch(git.rest.join(' '));
    if (git.subcommand === 'tag') return !isReadOnlyGitTag(git.rest.join(' '));
    return ['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'rebase', 'reset', 'restore', 'rm', 'stash', 'switch'].includes(git.subcommand);
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(binary)) {
    const subcommand = tokens[1] ?? '';
    return ['add', 'install', 'i', 'remove', 'rm', 'update', 'upgrade', 'dedupe', 'prune'].includes(subcommand);
  }
  return false;
}

export function splitSimpleCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseGitCommand(tokens: string[]): { subcommand: string; rest: string[] } | undefined {
  if (tokens[0] !== 'git') return undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
      index += 1;
      continue;
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) continue;
    return { subcommand: token, rest: tokens.slice(index + 1) };
  }

  return undefined;
}

function hasShellMetaOutsideQuotes(command: string, isUnsafe: (char: string, quote: 'single' | 'double' | undefined) => boolean): boolean {
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (isUnsafe(char, quote)) return true;
  }

  return quote !== undefined;
}

function hasUnsafeShellMetaOutsideQuotes(command: string): boolean {
  return hasShellMetaOutsideQuotes(command, (char, quote) => {
    if (char === '`') return true;
    if (char === '$' && quote !== 'single') return true;
    if (quote !== undefined) return false;
    return /[;&|><\n\r]/.test(char);
  });
}

function isReadOnlyGitBranch(rest: string): boolean {
  if (rest === '') return true;
  if (/(?:^|\s)(?:-(?:d|D|m|M|c|C)|--(?:delete|move|copy|force))\b/.test(rest)) return false;

  const tokens = rest.split(/\s+/).filter(Boolean);
  let allowsPatternArgs = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (/^-[rav]+$/.test(token)) {
      allowsPatternArgs = true;
      continue;
    }
    if (['--list', '--all', '--remotes', '--verbose'].includes(token)) {
      allowsPatternArgs = true;
      continue;
    }
    if (['--show-current', '--color', '--no-color', '--column', '--no-column'].includes(token)) continue;
    if (['--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort'].includes(token)) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) index += 1;
      continue;
    }
    if (/^--(?:contains|points-at|format|sort)=\S+$/.test(token)) continue;
    if (allowsPatternArgs && !token.startsWith('-')) continue;
    return false;
  }
  return true;
}

function isReadOnlyGitTag(rest: string): boolean {
  if (rest === '') return true;
  if (/(?:^|\s)(?:-(?:a|d|f|m|s|u)|--(?:annotate|delete|force|local-user|message|sign))\b/.test(rest)) return false;

  const tokens = rest.split(/\s+/).filter(Boolean);
  let allowsPatternArgs = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (/^-n\d*$/.test(token)) continue;
    if (token === '-l' || token === '--list') {
      allowsPatternArgs = true;
      continue;
    }
    if (token === '-v' || token === '--verify') {
      const next = tokens[index + 1];
      if (!next || next.startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (['--column', '--no-column'].includes(token)) continue;
    if (['--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort'].includes(token)) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) index += 1;
      continue;
    }
    if (/^--(?:contains|points-at|format|sort)=\S+$/.test(token)) continue;
    if (allowsPatternArgs && !token.startsWith('-')) continue;
    return false;
  }
  return true;
}

export function isReadOnlyReviewBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Review turns should only inspect state. Block shell composition and
  // redirection so an otherwise read-only command cannot be chained into a
  // mutation such as `git diff > file` or `grep x | xargs rm`. Quoted regex
  // metacharacters like `rg 'foo|bar'` are allowed.
  if (hasUnsafeShellMetaOutsideQuotes(trimmed)) return false;

  const tokens = splitSimpleCommand(trimmed);
  const [binary = ''] = tokens;
  if (binary === 'git') {
    const parsed = parseGitCommand(tokens);
    if (!parsed) return false;
    const { subcommand, rest } = parsed;
    // Block flags that can execute external commands or write output to disk.
    if (rest.some((t) => t === '--output' || t.startsWith('--output='))) return false;
    if (rest.some((t) => t === '--ext-diff' || t === '--external-diff')) return false;
    if (subcommand === 'branch') return isReadOnlyGitBranch(rest.join(' '));
    if (subcommand === 'tag') return isReadOnlyGitTag(rest.join(' '));
    return ['blame', 'diff', 'ls-files', 'log', 'rev-parse', 'show', 'status'].includes(subcommand);
  }

  if (binary === 'find') {
    if (/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls|chmod|chown)\b/.test(trimmed)) return false;
    return true;
  }

  return READ_ONLY_REVIEW_COMMANDS.has(binary);
}

export function isCurrentWorktreeReviewFile(file: string): boolean {
  return file !== '.worktree' && !file.startsWith('.worktree/');
}

function parseStatusLineFiles(line: string): string[] {
  if (line.length < 3) return [];
  const pathPart = line.slice(3).trim();
  return pathPart.split(' -> ').map((file) => file.trim()).filter((file) => file.length > 0);
}

function parseStatusLineReviewFile(line: string): string {
  const files = parseStatusLineFiles(line);
  const target = files.at(-1) ?? '';
  if (isCurrentWorktreeReviewFile(target)) return target;
  return files.find(isCurrentWorktreeReviewFile) ?? '';
}

export function filterCurrentWorktreeStatus(status: string): string {
  const lines = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && parseStatusLineFiles(line).some(isCurrentWorktreeReviewFile));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function parseChangedFiles(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && parseStatusLineFiles(line).some(isCurrentWorktreeReviewFile))
    .map(parseStatusLineReviewFile)
    .filter((file) => file.length > 0);
}

export function shouldRunReview(input: ReviewDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.reviewQueued) return false;
  if (input.reviewInProgress) return false;

  const statusChanged = input.beforeStatus.trim() !== input.afterStatus.trim();
  const headChanged = (input.beforeHead ?? '').trim() !== (input.afterHead ?? '').trim();
  const hasCurrentChanges = input.afterStatus.trim().length > 0;

  if (input.sawMutationTool) return statusChanged || headChanged || hasCurrentChanges;
  return statusChanged || headChanged;
}

function serializeEffectiveConfig(config: Required<AutoReviewConfig>): string {
  // blockInputDuringReview and reviewStartWatchdogMs are extension-only controls the skill does not need.
  const { blockInputDuringReview: _b, reviewStartWatchdogMs: _w, ...rest } = config;
  const filtered = { ...rest, reviewerProfiles: config.reviewerProfiles.filter((profile) => profile.enabled !== false) };
  return JSON.stringify(filtered, null, 2);
}

export function buildReviewPrompt(input?: ReviewPromptInput): string {
  if (!input) return AUTO_REVIEW_SKILL_COMMAND;

  const beforeHead = input.beforeHead?.trim() ?? '';
  const afterHead = input.afterHead?.trim() ?? '';
  const reviewCwd = input.reviewCwd?.trim() ?? '';
  const effectiveConfig = input.effectiveConfig;
  const isCommittedCleanWorktree = beforeHead.length > 0
    && afterHead.length > 0
    && beforeHead !== afterHead
    && (input.status ?? '').trim().length === 0;

  if (!isCommittedCleanWorktree && reviewCwd.length === 0 && !effectiveConfig) return AUTO_REVIEW_SKILL_COMMAND;

  const contextLines = [
    'Auto-review context:',
    ...(reviewCwd.length > 0 ? [`Review worktree root: ${reviewCwd}`] : []),
    ...(isCommittedCleanWorktree ? [`Committed clean-worktree range: ${beforeHead}..${afterHead}`] : []),
    ...(effectiveConfig ? [`Effective config:\n${serializeEffectiveConfig(effectiveConfig)}`] : []),
  ];

  return `${AUTO_REVIEW_SKILL_COMMAND}\n\n${contextLines.join('\n')}`;
}
