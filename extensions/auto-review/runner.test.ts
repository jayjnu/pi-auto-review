import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReviewer } from './runner.ts';

interface ExecCall {
  command: string;
  args: string[];
  options: { cwd: string; signal?: AbortSignal };
}

describe('runReviewer', () => {
  it('writes a meta prompt, invokes child pi without model overrides, and extracts final output', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pi-auto-review-test-'));
    const calls: ExecCall[] = [];

    try {
      const result = await runReviewer({
        cwd: '/repo',
        task: 'Review now',
        tempDir,
        exec: async (command, args, options) => {
          calls.push({ command, args, options });
          const promptPath = args[args.indexOf('--append-system-prompt') + 1];
          const metaPrompt = await readFile(promptPath, 'utf8');
          expect(metaPrompt).toContain('automated post-change code reviewer');
          return {
            stdout: JSON.stringify({
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: 'Looks good' }] },
            }),
            stderr: '',
            code: 0,
          };
        },
      });

      expect(result).toEqual({ text: 'Looks good', stderr: '', code: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('pi');
      expect(calls[0].options.cwd).toBe('/repo');
      expect(calls[0].args).not.toContain('--model');
      expect(calls[0].args).not.toContain('--thinking');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns stderr when the child process fails before producing assistant text', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pi-auto-review-test-'));

    try {
      const result = await runReviewer({
        cwd: '/repo',
        task: 'Review now',
        tempDir,
        exec: async () => ({ stdout: '', stderr: 'child failed', code: 1 }),
      });

      expect(result.text).toContain('child failed');
      expect(result.code).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
