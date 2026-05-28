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

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review queued', 'info');
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await flushQueuedReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('/skill:auto-review'));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('src/index.ts'));
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

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('git diff --no-ext-diff abc..def'));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('src/index.ts'));
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
      expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; state: idle', 'info');
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
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is queued. Please send your message after it completes.', 'warning');

    ctx.isIdle.mockReturnValue(true);
    await flushQueuedReview();
    expect(await pi.handlers.input[0]({ source: 'extension', text: 'auto review' }, ctx)).toBeUndefined();

    await pi.handlers.session_shutdown[0]({}, ctx);
  });

  it('blocks user input while a review is running', async () => {
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
    await pi.handlers.before_agent_start[0]({ prompt: `transformed\n${prompt}` }, ctx);

    expect(await pi.handlers.input[0]({ source: 'interactive', text: 'interrupt review' }, ctx)).toEqual({ action: 'handled' });
    expect(await pi.handlers.input[0]({ source: 'extension', text: 'extension interrupt' }, ctx)).toEqual({ action: 'handled' });
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is running. Please send your message after it completes.', 'warning');
  });

  it('blocks mutation tools before reviewer result but allows fixes after subagent review', async () => {
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
    await pi.handlers.before_agent_start[0]({ prompt: `transformed\n${prompt}` }, ctx);
    await pi.handlers.agent_start[0]({}, ctx);

    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toEqual({
      block: true,
      reason: 'Auto review is read-only. Do not edit or write files during the review turn.',
    });
    expect(await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'git diff --no-ext-diff' } }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'git commit -am fix' } }, ctx)).toEqual({
      block: true,
      reason: 'Auto review is read-only. Use only read-only inspection commands during the review turn.',
    });
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'worker' } }, ctx)).toEqual({
      block: true,
      reason: 'Auto review is waiting for the reviewer subagent. Do not call other subagents before the reviewer result returns.',
    });
    expect(await pi.handlers.tool_call[0]({ toolName: 'subagent', input: { agent: 'reviewer' } }, ctx)).toBeUndefined();

    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'worker' }, isError: false }, ctx);
    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toEqual({
      block: true,
      reason: 'Auto review is read-only. Do not edit or write files during the review turn.',
    });

    await pi.handlers.tool_result[0]({ toolName: 'subagent', input: { agent: 'reviewer' }, isError: false }, ctx);

    expect(await pi.handlers.tool_call[0]({ toolName: 'edit' }, ctx)).toBeUndefined();
    expect(await pi.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'npm test' } }, ctx)).toBeUndefined();
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
    expect(pi.sendUserMessage.mock.calls[1][0]).toContain('src/fix.ts');
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
    expect(pi.sendUserMessage.mock.calls[1][0]).toContain('generated.ts');
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
});
