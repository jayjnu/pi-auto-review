import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import autoReviewExtension from './index.ts';

interface FakePi {
  flags: Record<string, unknown>;
  commands: Record<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>;
  handlers: Record<string, Array<(event: any, ctx: FakeContext) => Promise<unknown> | unknown>>;
  registerFlag: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

interface FakeContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn> };
  isIdle: ReturnType<typeof vi.fn>;
}

function createFakeContext(): FakeContext {
  return {
    cwd: '/repo',
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: vi.fn(() => true),
  };
}

async function flushQueuedReview(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function gitSubcommand(args: string[]): string | undefined {
  return args[0] === '-C' ? args[2] : args[0];
}

const tempDirs: string[] = [];
let hadOriginalSubagentChildEnv = false;
let originalSubagentChildEnv: string | undefined;

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-review-session-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  hadOriginalSubagentChildEnv = Object.prototype.hasOwnProperty.call(process.env, 'PI_SUBAGENT_CHILD');
  originalSubagentChildEnv = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
});

afterEach(() => {
  if (hadOriginalSubagentChildEnv && originalSubagentChildEnv !== undefined) process.env.PI_SUBAGENT_CHILD = originalSubagentChildEnv;
  else delete process.env.PI_SUBAGENT_CHILD;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createFakePi(flagValue = false): FakePi {
  const fake: FakePi = {
    flags: {},
    commands: {},
    handlers: {},
    registerFlag: vi.fn((name: string, options: unknown) => {
      fake.flags[name] = options;
    }),
    registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: FakeContext) => Promise<void> }) => {
      fake.commands[name] = command;
    }),
    on: vi.fn((name: string, handler: (event: any, ctx: FakeContext) => Promise<unknown> | unknown) => {
      fake.handlers[name] ??= [];
      fake.handlers[name].push(handler);
    }),
    getFlag: vi.fn(() => flagValue),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    sendUserMessage: vi.fn(),
  };
  return fake;
}

describe('autoReviewExtension', () => {
  it('does not register commands or lifecycle hooks in subagent children', () => {
    process.env.PI_SUBAGENT_CHILD = '1';
    const pi = createFakePi();

    autoReviewExtension(pi as never);

    expect(pi.registerFlag).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.handlers).toEqual({});
  });

  it('registers disable flag, control command, and lifecycle handlers', () => {
    const pi = createFakePi();

    autoReviewExtension(pi as never);

    expect(pi.registerFlag).toHaveBeenCalledWith('no-auto-review', {
      description: 'Disable automatic post-change code review',
      type: 'boolean',
      default: false,
    });
    expect(pi.registerCommand).toHaveBeenCalledWith('auto-review', expect.objectContaining({ description: expect.any(String) }));
    expect(pi.handlers.session_start).toHaveLength(1);
    expect(pi.handlers.input).toHaveLength(1);
    expect(pi.handlers.before_agent_start).toHaveLength(1);
    expect(pi.handlers.agent_start).toHaveLength(1);
    expect(pi.handlers.tool_call).toHaveLength(1);
    expect(pi.handlers.tool_result).toHaveLength(1);
    expect(pi.handlers.agent_end).toHaveLength(1);
  });

  it('reflects no-auto-review flag in runtime status', async () => {
    const pi = createFakePi(true);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; disabled (--no-auto-review flag); state: idle', 'info');
  });

  it('warns when runtime on cannot override no-auto-review flag', async () => {
    const pi = createFakePi(true);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('on', ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review remains disabled because Pi was started with --no-auto-review', 'warning');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; disabled (--no-auto-review flag); state: idle', 'info');
  });

  it('warns at session start when skill commands are disabled', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    const dir = createTempDir();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'settings.json'), JSON.stringify({ enableSkillCommands: false }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('enableSkillCommands is false'), 'warning');
  });

  it('supports runtime on and off commands', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.commands['auto-review'].handler('off', ctx);
    await pi.commands['auto-review'].handler('status', ctx);
    await pi.commands['auto-review'].handler('on', ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review disabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; disabled (session: /auto-review off); state: idle', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review enabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (session: /auto-review on); state: idle', 'info');
  });

  it.each([
    { name: '--no-auto-review flag true', flag: true, preCommand: undefined, configEnabled: undefined, callSessionStart: true, expected: 'Auto review is disabled; disabled (--no-auto-review flag); state: idle' },
    { name: '/auto-review off', flag: false, preCommand: 'off', configEnabled: undefined, callSessionStart: true, expected: 'Auto review is disabled; disabled (session: /auto-review off); state: idle' },
    { name: '/auto-review on', flag: false, preCommand: 'on', configEnabled: undefined, callSessionStart: true, expected: 'Auto review is enabled; enabled (session: /auto-review on); state: idle' },
    { name: 'config enabled=false', flag: false, preCommand: undefined, configEnabled: false, callSessionStart: true, expected: 'Auto review is disabled; disabled (config: enabled=false); state: idle' },
    { name: 'config enabled=true', flag: false, preCommand: undefined, configEnabled: true, callSessionStart: true, expected: 'Auto review is enabled; enabled (config: enabled=true); state: idle' },
    { name: 'pre-session-start default (config not yet loaded)', flag: false, preCommand: undefined, configEnabled: undefined, callSessionStart: false, expected: 'Auto review is enabled; enabled (default); state: idle' },
  ])('enabled-source: $name', async ({ flag, preCommand, configEnabled, callSessionStart, expected }) => {
    const pi = createFakePi(flag);
    const ctx = createFakeContext();
    if (configEnabled !== undefined) {
      const dir = createTempDir();
      ctx.cwd = dir;
      fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ enabled: configEnabled }));
    }
    autoReviewExtension(pi as never);
    if (callSessionStart) await pi.handlers.session_start[0]({}, ctx);
    if (preCommand !== undefined) await pi.commands['auto-review'].handler(preCommand, ctx);
    await pi.commands['auto-review'].handler('status', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expected, 'info');
  });

  it('resets follow-up review state across session_shutdown and session_start', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const firstPrompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(firstPrompt).not.toContain('Review pass: 2 (follow-up)');

    // Simulate session shutdown + new session start
    await pi.handlers.session_shutdown[0]({}, ctx);
    await pi.handlers.session_start[0]({}, ctx);

    // Queue another review in the new session
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const secondPrompt = pi.sendUserMessage.mock.calls[1][0] as string;
    expect(secondPrompt).not.toContain('Review pass: 2 (follow-up)');
    expect(secondPrompt).not.toContain('Incremental range since last review');
  });

  it('queues a main-agent follow-up review when files changed', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review queued (pass 1)', 'info');
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\/skill:auto-review[\s\S]*Effective config:/));
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('uses top-level pathspecs with git -C ctx.cwd so subdirectory sessions still review the full current worktree', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    ctx.cwd = '/repo/packages/app';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\/skill:auto-review[\s\S]*Effective config:/));
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/packages/app', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/packages/app', 'diff', '--no-ext-diff', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/packages/app', 'diff', '--cached', '--no-ext-diff', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('does not queue review for nested .worktree-only changes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M .worktree/feature/src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('scopes review to the worktree root of an edited nested worktree file', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    const repo = createTempDir();
    const featureRoot = path.join(repo, '.worktree', 'feature');
    fs.mkdirSync(path.join(featureRoot, 'src'), { recursive: true });
    ctx.cwd = repo;
    let featureStatusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      const cwd = args[0] === '-C' ? args[1] : ctx.cwd;
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) {
        return { stdout: cwd?.includes(featureRoot) ? `${featureRoot}\n` : `${repo}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'status') {
        if (cwd === featureRoot) {
          featureStatusCalls += 1;
          return { stdout: featureStatusCalls >= 2 ? ' M src/index.ts\n' : '', stderr: '', code: 0 };
        }
        return { stdout: ' M main.ts\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_call[0]({ toolName: 'edit', input: { path: '.worktree/feature/src/index.ts' } }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', input: { path: '.worktree/feature/src/index.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toContain(`Review worktree root: ${featureRoot}`);
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', featureRoot, 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).not.toHaveBeenCalledWith('git', ['-C', repo, 'diff', '--no-ext-diff', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('queues committed clean-worktree review for writes under non-existing directories', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let headCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      const cwd = args[0] === '-C' ? args[1] : ctx.cwd;
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) {
        return cwd === '/repo' ? { stdout: '/repo\n', stderr: '', code: 0 } : { stdout: '', stderr: 'not a git repository', code: 128 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'status') {
        return cwd === '/repo' ? { stdout: '', stderr: '', code: 0 } : { stdout: '', stderr: 'not a git repository', code: 128 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') {
        if (cwd !== '/repo') return { stdout: '', stderr: 'not a git repository', code: 128 };
        headCalls += 1;
        return { stdout: `${headCalls <= 2 ? 'abc' : 'def'}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--name-only')) return { stdout: 'src/index.ts\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_call[0]({ toolName: 'write', input: { path: 'new-dir/src/index.ts' } }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', input: { path: 'new-dir/src/index.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('Committed clean-worktree range: abc..def');
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo', 'diff', '--name-only', '-z', 'abc..def', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('normalizes relative bash cwd before locking review scope', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let featureStatusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      const cwd = args[0] === '-C' ? args[1] : ctx.cwd;
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) {
        return { stdout: cwd === '/repo/.worktree/feature' ? '/repo/.worktree/feature\n' : '/repo\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'status') {
        if (cwd === '/repo/.worktree/feature') {
          featureStatusCalls += 1;
          return { stdout: featureStatusCalls >= 2 ? ' M src/index.ts\n' : '', stderr: '', code: 0 };
        }
        return { stdout: ' M main.ts\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'touch src/index.ts', cwd: '.worktree/feature' } }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'touch src/index.ts', cwd: '.worktree/feature' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('Review worktree root: /repo/.worktree/feature');
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/.worktree/feature', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('uses git -C from mutating bash commands as the review scope', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let featureStatusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      const cwd = args[0] === '-C' ? args[1] : ctx.cwd;
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) {
        return { stdout: cwd === '/repo/.worktree/feature' ? '/repo/.worktree/feature\n' : '/repo\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'status') {
        if (cwd === '/repo/.worktree/feature') {
          featureStatusCalls += 1;
          return { stdout: featureStatusCalls >= 2 ? ' M src/index.ts\n' : '', stderr: '', code: 0 };
        }
        return { stdout: ' M main.ts\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'git -C .worktree/feature commit -am fix' } }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'git -C .worktree/feature commit -am fix' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('Review worktree root: /repo/.worktree/feature');
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/.worktree/feature', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).not.toHaveBeenCalledWith('git', ['-C', '/repo', 'diff', '--no-ext-diff', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('resolves repeated git -C options compositionally for mutating bash review scope', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let featureStatusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      const cwd = args[0] === '-C' ? args[1] : ctx.cwd;
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) {
        return { stdout: cwd === '/repo/.worktree/feature' ? '/repo/.worktree/feature\n' : '/repo\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'status') {
        if (cwd === '/repo/.worktree/feature') {
          featureStatusCalls += 1;
          return { stdout: featureStatusCalls >= 2 ? ' M src/index.ts\n' : '', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'git -C .worktree -C feature commit -am x' } }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'git -C .worktree -C feature commit -am x' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('Review worktree root: /repo/.worktree/feature');
    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo/.worktree/feature', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).not.toHaveBeenCalledWith('git', ['-C', '/repo/.worktree', 'status', '--porcelain', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.exec).not.toHaveBeenCalledWith('git', ['-C', '/repo', 'diff', '--no-ext-diff', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
  });

  it('does not let pre-mutation review cwd probes block the user tool call', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--show-toplevel')) throw new Error('probe failed');
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);

    await expect(pi.handlers.tool_call[0]({ toolName: 'write', input: { path: 'src/index.ts' } }, ctx)).resolves.toBeUndefined();
  });

  it('captures full diff snapshots lazily only when a fixer subagent is about to run', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let diffCalls = 0;
    let currentWorktreeDiff = 'diff -- old content\n';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff')) {
        diffCalls += 1;
        if (!args.includes('--cached')) return { stdout: currentWorktreeDiff, stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    expect(diffCalls).toBe(0);

    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    expect(diffCalls).toBe(2);
    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    expect(diffCalls).toBe(2);

    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'reviewer', task: 'review' } }, ctx);
    expect(diffCalls).toBe(2);

    const fixerInput = { agent: 'worker', task: 'fix accepted findings' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: fixerInput }, ctx);
    expect(diffCalls).toBe(4);

    currentWorktreeDiff = 'diff -- fixer content\n';
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: fixerInput, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    expect(diffCalls).toBe(6);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('queues a compact committed range review prompt for committed clean-worktree current-worktree changes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let revParseCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') {
        revParseCalls += 1;
        return { stdout: `${revParseCalls === 1 ? 'abc' : 'def'}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--name-only')) return { stdout: '.worktree/feature/src/index.ts\0src/index.ts\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    await flushQueuedReview();

    const prompt = pi.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain('/skill:auto-review');
    expect(prompt).toContain('Committed clean-worktree range: abc..def');
    expect(prompt).not.toContain('Changed files:');
    expect(prompt).not.toContain('diff --git');
  });

  it('does not queue review for committed-only HEAD changes with only nested .worktree files', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let revParseCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') {
        revParseCalls += 1;
        return { stdout: `${revParseCalls === 1 ? 'abc' : 'def'}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--name-only')) return { stdout: '.worktree/feature/src/index.ts\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.exec).toHaveBeenCalledWith('git', ['-C', '/repo', 'diff', '--name-only', '-z', 'abc..def', '--', ':/', ':(top,exclude).worktree', ':(top,exclude).worktree/**'], { signal: ctx.signal });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('clears queued review state if starting the review turn fails', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    pi.sendUserMessage.mockImplementation(() => {
      throw new Error('send failed');
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    await pi.handlers.before_agent_start[0]({ prompt: 'normal user turn' }, ctx);
    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
    await pi.commands['auto-review'].handler('status', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (config: enabled=true); state: idle', 'info');
  });

  it('keeps prompts compact after a queued review dispatch fails', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let statusCalls = 0;
    const heads = ['a', 'a', 'a', 'b', 'b', 'c'];
    let headIndex = 0;
    let shouldThrowOnSend = false;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls === 2 ? ' M src/index.ts\n' : '', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') {
        const head = heads[headIndex] ?? heads.at(-1) ?? 'c';
        headIndex += 1;
        return { stdout: `${head}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--name-only')) return { stdout: 'src/commit.ts\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    pi.sendUserMessage.mockImplementation(() => {
      if (shouldThrowOnSend) throw new Error('send failed');
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);

    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    shouldThrowOnSend = true;
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    shouldThrowOnSend = false;
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
    const prompt = pi.sendUserMessage.mock.calls[2][0] as string;
    expect(prompt).toContain('Committed clean-worktree range: b..c');
    expect(prompt).not.toContain('Review pass:');
    expect(prompt).not.toContain('Incremental range since last review');
  });

  it('clears starting review state if the review turn never starts', async () => {
    vi.useFakeTimers();
    try {
      const pi = createFakePi(false);
      const ctx = createFakeContext();
      pi.exec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });

      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.handlers.agent_start[0]({}, ctx);
      await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
      await pi.handlers.agent_end[0]({}, ctx);
      await vi.advanceTimersByTimeAsync(0);

      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await pi.handlers.before_agent_start[0]({ prompt: 'normal user turn' }, ctx);

      expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
      await pi.commands['auto-review'].handler('status', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (config: enabled=true); state: idle; completed passes: 1', 'info');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not queue duplicate reviews while one is already queued', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    ctx.isIdle.mockReturnValue(false);
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    await pi.handlers.agent_end[0]({}, ctx);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await pi.handlers.session_shutdown[0]({}, ctx);
  });

  it('does not treat arbitrary marker-containing user prompts as review turns', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.before_agent_start[0]({ prompt: 'please inspect <!-- pi-auto-review-turn --> literally' }, ctx);

    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
  });

  it('blocks user input while a review is queued but allows the extension review message', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    ctx.isIdle.mockReturnValue(false);
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(await pi.handlers.input[0]({ source: 'interactive', text: 'next task' }, ctx)).toEqual({ action: 'handled' });
    expect(await pi.handlers.input[0]({ source: 'extension', text: 'other extension message' }, ctx)).toEqual({ action: 'handled' });
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is queued. Please send your message after it starts or press Esc to interrupt.', 'warning');

    ctx.isIdle.mockReturnValue(true);
    await flushQueuedReview();
    expect(await pi.handlers.input[0]({ source: 'extension', text: 'auto review' }, ctx)).toBeUndefined();

    await pi.handlers.session_shutdown[0]({}, ctx);
  });

  it('does not block input or tools after the queued review message is dispatched', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(await pi.handlers.input[0]({ source: 'interactive', text: 'interrupt review' }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'git commit -am fix' } }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'worker' } }, ctx)).toBeUndefined();
  });

  it('queues another review after the review turn applies bash fixes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let statusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M src/fix.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'echo fix > src/fix.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toMatch(/^\/skill:auto-review[\s\S]*Effective config:/);
  });

  it('does not queue another review for an identical already-queued fingerprint', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'echo fix > src/index.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('queues another review when same-file diff content changes with unchanged status', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let currentWorktreeDiff = 'diff -- old content\n';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        return { stdout: currentWorktreeDiff, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    currentWorktreeDiff = 'diff -- new content\n';
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'echo fix > src/index.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('queues another review after unclassified bash changes files during the review fix phase', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let statusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M generated.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'python scripts/generate.py' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toMatch(/^\/skill:auto-review[\s\S]*Effective config:/);
  });

  it('queues another review after the configured fixer subagent changes same-file diff content', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let currentWorktreeDiff = 'diff -- old content\n';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        return { stdout: currentWorktreeDiff, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    const fixerInput = { agent: 'worker', task: 'fix accepted findings' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: fixerInput }, ctx);
    currentWorktreeDiff = 'diff -- fixer content\n';
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: fixerInput, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('queues another review after an errored configured fixer subagent changes same-file diff content', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let currentWorktreeDiff = 'diff -- old content\n';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        return { stdout: currentWorktreeDiff, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    const fixerInput = { agent: 'worker', task: 'fix accepted findings' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: fixerInput }, ctx);
    currentWorktreeDiff = 'diff -- partial errored fixer content\n';
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: fixerInput, isError: true }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('queues another review after the configured fixer subagent changes already-untracked file content', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let untrackedContentHash = 'old-untracked-hash';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: '?? generated.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'ls-files' && args.includes('--others')) return { stdout: 'generated.ts\0', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'hash-object') return { stdout: `${untrackedContentHash}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    const fixerInput = { agent: 'worker', task: 'fix accepted findings in generated.ts' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: fixerInput }, ctx);
    untrackedContentHash = 'new-untracked-hash';
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: fixerInput, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('does not queue another review after the default fixer agent runs without changing git state', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        return { stdout: 'diff -- unchanged dirty content\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    const workerInput = { agent: 'worker', task: 'unrelated worker that only reports status' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: workerInput }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: workerInput, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('queues another review after a custom configured fixer subagent changes same-file diff content', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ fixerAgent: 'auto-review-fixer' }));
    let currentWorktreeDiff = 'diff -- old content\n';
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        return { stdout: currentWorktreeDiff, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'worker', task: 'unrelated worker should not count as fixer' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await pi.handlers.agent_start[0]({}, ctx);
    const fixerInput = { agent: 'auto-review-fixer', task: 'fix accepted findings' };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input: fixerInput }, ctx);
    currentWorktreeDiff = 'diff -- custom fixer content\n';
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: fixerInput, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('does not schedule another review after the review turn ends without fixes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('loads config and passes effective config inline in the dispatched prompt', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerAgent: 'custom-reviewer' }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    expect(prompt).toMatch(/^\/skill:auto-review[\s\S]*Effective config:/);
    expect(prompt).toContain('"reviewerAgent": "custom-reviewer"');

    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'custom-reviewer' } }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'reviewer' } }, ctx)).toBeUndefined();
  });

  it('reloads config at agent_end so direct file edits take effect without /auto-review config set', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: '', stderr: '', code: 1 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);

    // First turn: review is enabled, should queue
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Disable via direct file edit (not /auto-review config set)
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false }));

    // Second turn: review should be disabled, should NOT queue
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('finds project config in main repo via git-common-dir for linked worktrees outside the repo tree', async () => {
    const pi = createFakePi(false);
    const repo = createTempDir();
    const worktree = createTempDir(); // completely separate path
    const ctx = createFakeContext();
    ctx.cwd = worktree;
    const configPath = path.join(repo, '.pi', 'extensions', 'auto-review', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse' && args.includes('--git-common-dir')) {
        // Simulate linked worktree: common-dir points to main repo's .git
        return { stdout: `${path.join(repo, '.git')}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    // Config found via --git-common-dir says enabled: false, so no review should queue
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('strips disabled reviewer profiles from subagent tasks at tool_call level', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'keep-me', agent: 'reviewer', task: 'keep this reviewer', enabled: true },
        { id: 'disabled-one', agent: 'disabled-reviewer', task: 'should not dispatch', enabled: false },
      ],
    }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);

    const input: Record<string, unknown> = {
      tasks: [
        { agent: 'reviewer', task: '[auto-review:profile:keep-me]\nReview stuff.' },
        { agent: 'disabled-reviewer', task: '[auto-review:profile:disabled-one]\nReview stuff.' },
      ],
    };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input }, ctx);

    const tasks = (input.tasks as unknown[]);
    expect(tasks).toHaveLength(1);
    expect((tasks[0] as { task: string }).task).toContain('keep-me');
    expect(tasks.some((t) => typeof (t as { task?: string }).task === 'string' && (t as { task: string }).task.includes('disabled-one'))).toBe(false);
  });

  it('does not strip tasks based on custom labels of disabled profiles at tool_call level', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'custom-label-disabled', agent: 'reviewer', task: 'should not dispatch', label: 'short', enabled: false },
      ],
    }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);

    const input: Record<string, unknown> = {
      tasks: [
        { agent: 'reviewer', task: 'short review of something unrelated' },
        { agent: 'reviewer', task: '[auto-review:correctness]\nReview stuff.' },
      ],
    };
    await pi.handlers.tool_call[0]({ toolName: 'subagent', input }, ctx);

    const tasks = (input.tasks as unknown[]);
    expect(tasks).toHaveLength(2);
  });

  it('does not enforce mutation guard when autoFix is false', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);

    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
  });

  it('does not block user input when blockInputDuringReview is false', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    ctx.isIdle.mockReturnValue(false);
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ blockInputDuringReview: false }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(await pi.handlers.input[0]({ source: 'interactive', text: 'next task' }, ctx)).toBeUndefined();
  });

  it('uses custom reviewStartWatchdogMs', async () => {
    vi.useFakeTimers();
    try {
      const pi = createFakePi(false);
      const dir = createTempDir();
      const ctx = createFakeContext();
      ctx.cwd = dir;
      fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewStartWatchdogMs: 5000 }));
      pi.exec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });

      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.handlers.agent_start[0]({}, ctx);
      await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
      await pi.handlers.agent_end[0]({}, ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      await pi.handlers.before_agent_start[0]({ prompt: 'normal user turn' }, ctx);

      expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops queued review after custom reviewStartWatchdogMs when Pi never becomes idle', async () => {
    vi.useFakeTimers();
    try {
      const pi = createFakePi(false);
      const dir = createTempDir();
      const ctx = createFakeContext();
      ctx.cwd = dir;
      ctx.isIdle.mockReturnValue(false);
      fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewStartWatchdogMs: 5000 }));
      pi.exec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });

      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.handlers.agent_start[0]({}, ctx);
      await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
      await pi.handlers.agent_end[0]({}, ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      await pi.commands['auto-review'].handler('status', ctx);

      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (config: enabled=true); state: idle', 'info');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runtime /auto-review off overrides config enabled', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ enabled: true }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('off', ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('no-auto-review flag overrides config enabled', async () => {
    const pi = createFakePi(true);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ enabled: true }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('config init creates a project config file', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config init', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Created project config'), 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.enabled).toBe(true);
    expect(parsed.reviewerAgent).toBe('reviewer');
    expect(parsed.reviewerProfiles).toEqual([]);
    expect(parsed.reviewConcurrency).toBe(4);
    expect(parsed.includeBaselineReview).toBe(true);
    expect(parsed.fixerAgent).toBe('worker');
  });

  it('config init fails if config already exists', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ enabled: false }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config init', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('already exists'), 'error');
  });

  it('config set writes to project config and reloads', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set autoFix false', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set autoFix = false'), 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.autoFix).toBe(false);
  });

  it('config set enabled clears a prior /auto-review on so the value takes effect', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('on', ctx);
    await pi.commands['auto-review'].handler('config set enabled false', ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await pi.commands['auto-review'].handler('status', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; disabled (config: enabled=false); state: idle', 'info');
  });

  it('config set enabled clears a prior /auto-review off so the value takes effect', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('off', ctx);
    await pi.commands['auto-review'].handler('config set enabled true', ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\/skill:auto-review[\s\S]*Effective config:/));
    await pi.commands['auto-review'].handler('status', ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (config: enabled=true); state: idle; completed passes: 1', 'info');
  });

  it('config --global set writes to global config and reloads', async () => {
    const pi = createFakePi(false);
    const home = createTempDir();
    const project = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = project;
    const oldHome = process.env.HOME;
    process.env.HOME = home;

    try {
      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.commands['auto-review'].handler('config --global set includeBaselineReview false', ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(['Set includeBaselineReview = false (global)', 'info']);

      await pi.commands['auto-review'].handler('config get includeBaselineReview', ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(['includeBaselineReview: false', 'info']);

      await pi.commands['auto-review'].handler('config --global get includeBaselineReview', ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(['includeBaselineReview: false', 'info']);

      const configPath = path.join(home, '.pi', 'agent', 'extensions', 'auto-review', 'config.json');
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(parsed.includeBaselineReview).toBe(false);
      expect(fs.existsSync(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('config --project set writes to project config and project get reads project value', async () => {
    const pi = createFakePi(false);
    const home = createTempDir();
    const project = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = project;
    const oldHome = process.env.HOME;
    process.env.HOME = home;

    try {
      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.commands['auto-review'].handler('config --project set includeBaselineReview false', ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(['Set includeBaselineReview = false', 'info']);

      await pi.commands['auto-review'].handler('config --project get includeBaselineReview', ctx);
      expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(['includeBaselineReview: false', 'info']);

      const projectConfigPath = path.join(project, '.pi', 'extensions', 'auto-review', 'config.json');
      const parsed = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      expect(parsed.includeBaselineReview).toBe(false);
      expect(fs.existsSync(path.join(home, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('config --scope effective is invalid for mutations and does not write config', async () => {
    const pi = createFakePi(false);
    const home = createTempDir();
    const project = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = project;
    const oldHome = process.env.HOME;
    process.env.HOME = home;

    try {
      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.commands['auto-review'].handler('config --scope effective set autoFix false', ctx);

      const lastCall = ctx.ui.notify.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain('Usage:');
      expect(lastCall?.[1]).toBe('warning');
      expect(fs.existsSync(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('config --global init creates the global config file', async () => {
    const pi = createFakePi(false);
    const home = createTempDir();
    const ctx = createFakeContext();
    const oldHome = process.env.HOME;
    process.env.HOME = home;

    try {
      autoReviewExtension(pi as never);
      await pi.handlers.session_start[0]({}, ctx);
      await pi.commands['auto-review'].handler('config --global init', ctx);

      const configPath = path.join(home, '.pi', 'agent', 'extensions', 'auto-review', 'config.json');
      expect(ctx.ui.notify).toHaveBeenCalledWith(`Created global config at ${configPath}`, 'info');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).enabled).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('config set handles array values for reviewerSkills and fixerSkills', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewerSkills effect-ts-re reviewer', ctx);
    await pi.commands['auto-review'].handler('config set fixerSkills effect-typescript', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set reviewerSkills'), 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set fixerSkills'), 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.reviewerSkills).toEqual(['effect-ts-re', 'reviewer']);
    expect(parsed.fixerSkills).toEqual(['effect-typescript']);
  });

  it('config set handles reviewerProfiles JSON arrays', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewerProfiles [{"id":"frontend-perf","agent":"reviewer","model":"openai/gpt","skills":["frontend-review"],"task":"Check performance."}]', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set reviewerProfiles'), 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.reviewerProfiles).toEqual([{ id: 'frontend-perf', agent: 'reviewer', model: 'openai/gpt', skills: ['frontend-review'], task: 'Check performance.' }]);
  });

  it('config set handles autoFixSuggestions and includeBaselineReview boolean values', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set autoFixSuggestions true', ctx);
    await pi.commands['auto-review'].handler('config set includeBaselineReview false', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Set autoFixSuggestions = true', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Set includeBaselineReview = false', 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.autoFixSuggestions).toBe(true);
    expect(parsed.includeBaselineReview).toBe(false);
  });

  it('config set handles reviewConcurrency values', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewConcurrency 2', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Set reviewConcurrency = 2', 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.reviewConcurrency).toBe(2);
  });

  it('config set rejects reviewConcurrency above the safe maximum', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewConcurrency 9', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('at most 8'), 'error');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('config set handles maxReviewPasses values', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set maxReviewPasses 2', ctx);
    await pi.commands['auto-review'].handler('config set maxReviewPasses unlimited', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Set maxReviewPasses = 2', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Set maxReviewPasses = unlimited', 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.maxReviewPasses).toBeNull();
  });

  it('config set rejects invalid boolean value', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set autoFix maybe', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Expected boolean'), 'error');
  });

  it('config set rejects invalid number value', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewStartWatchdogMs -1', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Expected positive number'), 'error');
  });

  it('config get shows merged value', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config get autoFix', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('autoFix: false', 'info');
  });

  it('config show displays merged settings', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false, includeBaselineReview: true }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config', ctx);

    const lastCall = ctx.ui.notify.mock.calls[ctx.ui.notify.mock.calls.length - 1];
    expect(lastCall[0]).toContain('Auto review configuration');
    expect(lastCall[0]).toContain('autoFix: false');
    expect(lastCall[0]).toContain('reviewConcurrency: 4');
    expect(lastCall[0]).toContain('includeBaselineReview: true');
    expect(lastCall[0]).toContain('fixerAgent: worker');
    expect(lastCall[0]).toContain('autoFixSuggestions: false');
    expect(lastCall[0]).toContain('maxReviewPasses: unlimited');
  });

  it('status shows completed dispatched pass count', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; enabled (config: enabled=true); state: idle; completed passes: 1', 'info');
  });

  it('stops queueing after maxReviewPasses is reached', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ maxReviewPasses: 1 }));
    let statusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && gitSubcommand(args) === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M src/fix.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && gitSubcommand(args) === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'bash', input: { command: 'echo fix > src/fix.ts' }, isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review stopped after 1 pass(es); maxReviewPasses is 1.', 'info');
  });
});
