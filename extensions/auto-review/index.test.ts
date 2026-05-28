import { describe, expect, it, vi } from 'vitest';
import { buildReviewFingerprint } from './helpers.ts';
import autoReviewExtension from './index.ts';

interface FakePi {
  flags: Record<string, unknown>;
  commands: Record<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>;
  handlers: Record<string, Array<(event: any, ctx: FakeContext) => Promise<void> | void>>;
  registerFlag: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
}

interface FakeContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
  sessionManager: { getEntries: ReturnType<typeof vi.fn> };
}

function createFakeContext(entries: unknown[] = []): FakeContext {
  return {
    cwd: '/repo',
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: vi.fn(() => entries) },
  };
}

async function waitForBackgroundReview(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

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
    on: vi.fn((name: string, handler: (event: any, ctx: FakeContext) => Promise<void> | void) => {
      fake.handlers[name] ??= [];
      fake.handlers[name].push(handler);
    }),
    getFlag: vi.fn(() => flagValue),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
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
    expect(pi.registerFlag).toHaveBeenCalledWith('no-auto-review-fix', {
      description: 'Disable automatic follow-up fixes for auto-review findings',
      type: 'boolean',
      default: false,
    });
    expect(pi.registerCommand).toHaveBeenCalledWith('auto-review', expect.objectContaining({ description: expect.any(String) }));
    expect(pi.handlers.session_start).toHaveLength(1);
    expect(pi.handlers.agent_start).toHaveLength(1);
    expect(pi.handlers.tool_result).toHaveLength(1);
    expect(pi.handlers.agent_end).toHaveLength(1);
    expect(pi.handlers.session_shutdown).toHaveLength(1);
  });

  it('reflects no-auto-review and no-auto-review-fix flags in runtime status', async () => {
    const pi = createFakePi(true);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; auto-fix is disabled; 0 reviewed diff fingerprint(s) cached', 'info');
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
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled; auto-fix is enabled; 0 reviewed diff fingerprint(s) cached', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review enabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; auto-fix is enabled; 0 reviewed diff fingerprint(s) cached', 'info');
  });

  it('supports runtime auto-fix on and off commands', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();

    autoReviewExtension(pi as never);
    await pi.commands['auto-review'].handler('fix off', ctx);
    await pi.commands['auto-review'].handler('fix status', ctx);
    await pi.commands['auto-review'].handler('fix on', ctx);
    await pi.commands['auto-review'].handler('fix status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review auto-fix disabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; auto-fix is disabled; 0 reviewed diff fingerprint(s) cached', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review auto-fix enabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled; auto-fix is enabled; 0 reviewed diff fingerprint(s) cached', 'info');
  });

  it('posts a visible running message and stores the reviewed diff fingerprint', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: 'diff', stderr: '', code: 0 };
      if (command === 'pi') {
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nDone' }] },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await waitForBackgroundReview();

    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Auto review is running…') }));
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('## Skills Used') }));
    expect(pi.appendEntry).toHaveBeenCalledWith('auto-review-reviewed-diff', expect.objectContaining({ fingerprint: expect.any(String) }));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('auto-review', expect.stringMatching(/^reviewing /));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('auto-review', undefined);
  });

  it('requests a main-agent follow-up fix when the isolated reviewer finds actionable issues', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: 'diff', stderr: '', code: 0 };
      if (command === 'pi') {
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nFound one\n\n## Critical\n- Fix `src/index.ts:1`\n\n## Warnings\nNone' }],
            },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await waitForBackgroundReview();

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining('Auto review found Critical or Warning findings in the current diff. Fix them now.'),
      { deliverAs: 'followUp' },
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('## Critical'), { deliverAs: 'followUp' });
    expect(pi.appendEntry).toHaveBeenCalledWith('auto-review-reviewed-diff', expect.objectContaining({ autoFixRequested: true }));
  });

  it('does not request auto-fix for suggestion-only reviews', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: 'diff', stderr: '', code: 0 };
      if (command === 'pi') {
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nNit\n\n## Critical\nNone\n\n## Warnings\nNone\n\n## Suggestions\n- Optional docs update' }],
            },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await waitForBackgroundReview();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('## Suggestions') }));
    expect(pi.appendEntry).toHaveBeenCalledWith('auto-review-reviewed-diff', expect.objectContaining({ autoFixRequested: false }));
  });

  it('queues a pending review when another modifying turn ends while review is running', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let statusCalls = 0;
    let piCalls = 0;
    let releaseFirstReview!: () => void;
    const firstReviewFinished = new Promise<void>((resolve) => {
      releaseFirstReview = resolve;
    });

    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') {
        statusCalls += 1;
        const stdout = statusCalls <= 1
          ? ''
          : statusCalls <= 3
            ? ' M first.ts\n'
            : ' M first.ts\n M second.ts\n';
        return { stdout, stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'head\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: `diff-${statusCalls}`, stderr: '', code: 0 };
      if (command === 'pi') {
        piCalls += 1;
        if (piCalls === 1) await firstReviewFinished;
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nDone' }] },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review queued — another review is already running', 'info');

    releaseFirstReview();
    await waitForBackgroundReview();

    expect(piCalls).toBe(2);
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('second.ts') }));
  });

  it('does not use stale pi or ctx after session shutdown during background review', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let releaseReview!: () => void;
    const reviewFinished = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });

    pi.sendMessage.mockImplementation(() => {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    });
    ctx.ui.setStatus.mockImplementation(() => {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    });
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: 'diff', stderr: '', code: 0 };
      if (command === 'pi') {
        await reviewFinished;
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nDone' }] },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await pi.handlers.session_shutdown[0]({}, ctx);
    releaseReview();
    await waitForBackgroundReview();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reviews committed changes even when the worktree is clean', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let revParseCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'rev-parse') {
        revParseCalls += 1;
        return { stdout: `${revParseCalls === 1 ? 'abc' : 'def'}\n`, stderr: '', code: 0 };
      }
      if (command === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { stdout: ' src/index.ts \0', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('abc..def')) return { stdout: 'committed diff', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: '', stderr: '', code: 0 };
      if (command === 'pi') {
        return {
          stdout: JSON.stringify({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: '## Skills Used\n- None\n\n## Summary\nDone' }] },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);
    await waitForBackgroundReview();

    expect(pi.exec).toHaveBeenCalledWith('git', ['diff', '--no-ext-diff', '--binary', 'abc..def'], expect.any(Object));
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(' src/index.ts ') }));
    const piCall = pi.exec.mock.calls.find((call) => call[0] === 'pi');
    expect(piCall?.[1].join('\n')).toContain('abc..def');
  });

  it('reports auto-review failure when preflight git inspection throws', async () => {
    const pi = createFakePi(false);
    const ctx = createFakeContext();
    let statusCalls = 0;
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') {
        statusCalls += 1;
        if (statusCalls === 1) return { stdout: '', stderr: '', code: 0 };
        throw new Error('git status failed');
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'head\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Auto review failed: Error: git status failed') }));
  });

  it('skips a diff fingerprint that was already reviewed in this session', async () => {
    const fingerprint = buildReviewFingerprint({ status: ' M src/index.ts\n', diff: 'diff', cachedDiff: '' });
    const pi = createFakePi(false);
    const ctx = createFakeContext([
      { type: 'custom', customType: 'auto-review-reviewed-diff', data: { fingerprint } },
    ]);
    pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '', code: 0 };
      if (command === 'git' && args[0] === 'diff') return { stdout: 'diff', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.handlers.agent_start[0]({}, ctx);
    await pi.handlers.tool_result[0]({ toolName: 'edit', isError: false }, ctx);
    await pi.handlers.agent_end[0]({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review skipped — this diff was already reviewed', 'info');
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});
