import { describe, expect, it, vi } from 'vitest';
import autoReviewExtension from './index.ts';

interface FakePi {
  flags: Record<string, unknown>;
  commands: Record<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>;
  handlers: Record<string, Array<(event: any, ctx: FakeContext) => Promise<void> | void>>;
  registerFlag: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
}

interface FakeContext {
  ui: { notify: ReturnType<typeof vi.fn> };
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
    expect(pi.handlers.agent_start).toHaveLength(1);
    expect(pi.handlers.tool_result).toHaveLength(1);
    expect(pi.handlers.agent_end).toHaveLength(1);
  });

  it('reflects no-auto-review flag in runtime status', async () => {
    const pi = createFakePi(true);
    const ctx = { ui: { notify: vi.fn() } };

    autoReviewExtension(pi as never);
    await pi.handlers.session_start[0]({}, ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled', 'info');
  });

  it('supports runtime on and off commands', async () => {
    const pi = createFakePi(false);
    const ctx = { ui: { notify: vi.fn() } };

    autoReviewExtension(pi as never);
    await pi.commands['auto-review'].handler('off', ctx);
    await pi.commands['auto-review'].handler('status', ctx);
    await pi.commands['auto-review'].handler('on', ctx);
    await pi.commands['auto-review'].handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review disabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is disabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review enabled', 'info');
    expect(ctx.ui.notify).toHaveBeenCalledWith('Auto review is enabled', 'info');
  });
});
