import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMergedConfig } from './config.ts';

const scriptPath = path.join(process.cwd(), 'skills', 'auto-review', 'scripts', 'effective-config.mjs');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-review-config-'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function runScript(cwd: string, homeDir: string): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [scriptPath, cwd, homeDir], { encoding: 'utf-8' })) as Record<string, unknown>;
}

function skillVisibleConfig(cwd: string, homeDir: string): Record<string, unknown> {
  const { blockInputDuringReview: _b, reviewStartWatchdogMs: _w, ...config } = getMergedConfig(cwd, homeDir);
  return { ...config, reviewerProfiles: config.reviewerProfiles.filter((profile) => profile.enabled !== false) };
}

describe('auto-review effective-config skill helper', () => {

  it('prints defaults without extension-only controls', () => {
    const dir = tempDir();
    const config = runScript(dir, dir);

    expect(config.reviewerAgent).toBe('reviewer');
    expect(config.fixerAgent).toBe('worker');
    expect(config.reviewerProfiles).toEqual([]);
    expect(config).not.toHaveProperty('blockInputDuringReview');
    expect(config).not.toHaveProperty('reviewStartWatchdogMs');
  });

  it('merges global/project config and filters disabled reviewer profiles', () => {
    const home = tempDir();
    const project = tempDir();
    writeJson(path.join(home, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), {
      reviewerAgent: 'global-reviewer',
      reviewerProfiles: [
        { id: 'frontend', task: 'Check frontend.', skills: ['frontend-review'] },
        { id: 'off', task: 'Do not run.', enabled: false },
      ],
    });
    writeJson(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'), {
      reviewerAgent: 'project-reviewer',
      reviewConcurrency: 99,
      reviewerProfiles: [
        { id: 'frontend', agent: 'profile-agent', enabled: true },
        { id: 'project-off', task: 'Do not run either.', enabled: false },
      ],
    });

    const config = runScript(project, home);

    expect(config).toEqual(skillVisibleConfig(project, home));
    expect(config.reviewerAgent).toBe('project-reviewer');
    expect(config.reviewConcurrency).toBe(8);
    expect(config.reviewerProfiles).toEqual([
      { id: 'frontend', task: 'Check frontend.', skills: ['frontend-review'], agent: 'profile-agent', enabled: true },
    ]);
  });
});
