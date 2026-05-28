import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Configuration schema for pi-auto-review
export interface AutoReviewConfig {
  enabled?: boolean;
  reviewerAgent?: string;
  reviewerSkills?: string[];
  reviewerTaskExtra?: string;
  autoFix?: boolean;
  autoFixSuggestions?: boolean;
  blockInputDuringReview?: boolean;
  reviewStartWatchdogMs?: number;
  maxReviewPasses?: number | null;
}

const DEFAULT_CONFIG: Required<AutoReviewConfig> = {
  enabled: true,
  reviewerAgent: 'reviewer',
  reviewerSkills: [],
  reviewerTaskExtra: '',
  autoFix: true,
  autoFixSuggestions: false,
  blockInputDuringReview: true,
  reviewStartWatchdogMs: 30_000,
  maxReviewPasses: null,
};

function loadConfigFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function normalizeConfig(value: unknown): AutoReviewConfig {
  if (!value || typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;
  const result: AutoReviewConfig = {};
  if ('enabled' in obj && typeof obj.enabled === 'boolean') result.enabled = obj.enabled;
  if ('reviewerAgent' in obj && typeof obj.reviewerAgent === 'string' && obj.reviewerAgent.trim().length > 0) result.reviewerAgent = obj.reviewerAgent.trim();
  if ('reviewerSkills' in obj && Array.isArray(obj.reviewerSkills) && obj.reviewerSkills.every((s) => typeof s === 'string')) {
    result.reviewerSkills = obj.reviewerSkills;
  }
  if ('reviewerTaskExtra' in obj && typeof obj.reviewerTaskExtra === 'string') result.reviewerTaskExtra = obj.reviewerTaskExtra;
  if ('autoFix' in obj && typeof obj.autoFix === 'boolean') result.autoFix = obj.autoFix;
  if ('autoFixSuggestions' in obj && typeof obj.autoFixSuggestions === 'boolean') result.autoFixSuggestions = obj.autoFixSuggestions;
  if ('blockInputDuringReview' in obj && typeof obj.blockInputDuringReview === 'boolean') result.blockInputDuringReview = obj.blockInputDuringReview;
  if ('reviewStartWatchdogMs' in obj && typeof obj.reviewStartWatchdogMs === 'number' && Number.isFinite(obj.reviewStartWatchdogMs) && obj.reviewStartWatchdogMs > 0) {
    result.reviewStartWatchdogMs = obj.reviewStartWatchdogMs;
  }
  if ('maxReviewPasses' in obj) {
    if (obj.maxReviewPasses === null) result.maxReviewPasses = null;
    if (typeof obj.maxReviewPasses === 'number' && Number.isInteger(obj.maxReviewPasses) && obj.maxReviewPasses > 0) result.maxReviewPasses = obj.maxReviewPasses;
  }
  return result;
}

export type ConfigKey = keyof Required<AutoReviewConfig>;

const CONFIG_KEYS: ConfigKey[] = [
  'enabled',
  'reviewerAgent',
  'reviewerSkills',
  'reviewerTaskExtra',
  'autoFix',
  'autoFixSuggestions',
  'blockInputDuringReview',
  'reviewStartWatchdogMs',
  'maxReviewPasses',
];

export function isValidConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as string[]).includes(key);
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, '.pi', 'extensions', 'auto-review', 'config.json');
}

export function readProjectConfig(cwd: string): AutoReviewConfig {
  return normalizeConfig(loadConfigFile(getProjectConfigPath(cwd)));
}

export function writeProjectConfig(cwd: string, patch: AutoReviewConfig, opts?: { homeDir?: string }): void {
  const filePath = getProjectConfigPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existing = readProjectConfig(cwd);
  const merged = { ...existing, ...patch };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  // Reload merged config into active session if requested
  if (opts?.homeDir !== undefined) {
    // This is a side-effect free write; the caller should call getMergedConfig to refresh.
  }
}

export function initProjectConfig(cwd: string): void {
  const filePath = getProjectConfigPath(cwd);
  if (fs.existsSync(filePath)) {
    throw new Error(`Project config already exists at ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        enabled: true,
        reviewerAgent: 'reviewer',
        reviewerSkills: [],
        reviewerTaskExtra: '',
        autoFix: true,
        autoFixSuggestions: false,
        blockInputDuringReview: true,
        reviewStartWatchdogMs: 30_000,
        maxReviewPasses: null,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

export function parseConfigValue(key: ConfigKey, raw: string): unknown {
  const trimmed = raw.trim();
  if (key === 'enabled' || key === 'autoFix' || key === 'autoFixSuggestions' || key === 'blockInputDuringReview') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    throw new Error(`Expected boolean (true/false) for ${key}`);
  }
  if (key === 'reviewStartWatchdogMs') {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) throw new Error(`Expected positive number for ${key}`);
    return num;
  }
  if (key === 'maxReviewPasses') {
    if (['none', 'null', 'unlimited'].includes(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num <= 0) throw new Error(`Expected positive integer or unlimited/null/none for ${key}`);
    return num;
  }
  if (key === 'reviewerSkills') {
    if (trimmed === '[]') return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
    } catch { /* fall through */ }
    // Accept space-separated list as shorthand
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
    throw new Error(`Expected JSON array or space-separated list for ${key}`);
  }
  // string fields: reviewerAgent, reviewerTaskExtra
  return trimmed;
}

export function formatConfigValue(value: unknown): string {
  if (value === null) return 'unlimited';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value || '(empty)';
  return String(value);
}

export function getConfigDisplay(merged: Required<AutoReviewConfig>): string {
  const lines: string[] = [];
  for (const key of CONFIG_KEYS) {
    lines.push(`  ${key}: ${formatConfigValue(merged[key])}`);
  }
  return lines.join('\n');
}

export function getMergedConfig(cwd: string, homeDir = os.homedir()): Required<AutoReviewConfig> {
  const globalFile = path.join(homeDir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json');
  const projectFile = path.join(cwd, '.pi', 'extensions', 'auto-review', 'config.json');
  const globalConfig = normalizeConfig(loadConfigFile(globalFile));
  const projectConfig = normalizeConfig(loadConfigFile(projectFile));
  return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
