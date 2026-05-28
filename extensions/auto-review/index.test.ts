import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-review-session-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; state: idle', 'info');
  });

  it('warns when runtime on cannot override no-auto-review flag', async () => {
    const pi = createFakePi(true);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('on', ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review remains disabled because Pi was started with --no-auto-review', 'warning');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; state: idle', 'info');
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
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; state: idle', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review enabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle', 'info');
  });

  it('queues a main-agent follow-up review when files changed', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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

    expect(pi.sendUserMessage).toHaveBeenCalledWith('/skill:auto-review');
  });

  it('queues a main-agent follow-up review for committed clean-worktree changes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let revParseCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') {
        revParseCalls += 1;
        return { stdout: `${revParseCalls === 1 ? 'abc' : 'def'}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { stdout: 'src/index.ts\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'write', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith('/skill:auto-review');
  });

  it('clears queued review state if starting the review turn fails', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle', 'info');
  });

  it('clears starting review state if the review turn never starts', async () => {
    vi.useFakeTimers();
    try {
      const pi = createFakePi(false);
      const ctx = createFakeContext();
      pi.exec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle; completed passes: 1', 'info');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not queue duplicate reviews while one is already queued', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    ctx.isIdle.mockReturnValue(false);
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M src/fix.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
    expect(pi.sendUserMessage.mock.calls[1][0]).toBe('/skill:auto-review');
  });

  it('does not queue another review for an identical already-queued fingerprint', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
    let diffCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--no-ext-diff') && !args.includes('--cached')) {
        diffCalls += 1;
        return { stdout: diffCalls === 1 ? 'diff -- old content\n' : 'diff -- new content\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M generated.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
    expect(pi.sendUserMessage.mock.calls[1][0]).toBe('/skill:auto-review');
  });

  it('does not schedule another review after the review turn ends without fixes', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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

  it('loads config while keeping the dispatched prompt minimal', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerAgent: 'custom-reviewer' }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await flushQueuedReview();
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    expect(prompt).toBe('/skill:auto-review');

    await pi.handlers.before_agent_start[0]({ prompt }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'custom-reviewer' } }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'reviewer' } }, ctx)).toBeUndefined();
  });

  it('does not enforce mutation guard when autoFix is false', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;
    fs.mkdirSync(path.join(dir, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false }));
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
        if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
        if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle', 'info');
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
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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

  it('config set handles array values for reviewerSkills', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set reviewerSkills effect-ts-re reviewer', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set reviewerSkills'), 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.reviewerSkills).toEqual(['effect-ts-re', 'reviewer']);
  });

  it('config set handles autoFixSuggestions boolean values', async () => {
    const pi = createFakePi(false);
    const dir = createTempDir();
    const ctx = createFakeContext();
    ctx.cwd = dir;

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config set autoFixSuggestions true', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Set autoFixSuggestions = true', 'info');
    const configPath = path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.autoFixSuggestions).toBe(true);
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
    fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false }));

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('config', ctx);

    const lastCall = ctx.ui.notify.mock.calls[ctx.ui.notify.mock.calls.length - 1];
    expect(lastCall[0]).toContain('Auto review configuration');
    expect(lastCall[0]).toContain('autoFix: false');
    expect(lastCall[0]).toContain('autoFixSuggestions: false');
    expect(lastCall[0]).toContain('maxReviewPasses: unlimited');
  });

  it('status shows completed dispatched pass count', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle; completed passes: 1', 'info');
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
      if (command === 'git' && args[0] === 'status') {
        statusCalls += 1;
        return { stdout: statusCalls >= 4 ? ' M src/index.ts\n M src/fix.ts\n' : ' M src/index.ts\n', stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
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
