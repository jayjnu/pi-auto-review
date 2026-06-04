import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeReviewerProfiles, normalizeReviewerProfiles, REVIEWER_PROFILES_PARSE_ERROR, type ReviewerProfileConfig } from './reviewer-profiles.ts';

export type { ReviewerProfileConfig } from './reviewer-profiles.ts';

export interface AutoReviewConfig {
  enabled?: boolean;
  reviewerAgent?: string;
  reviewerSkills?: string[];
  reviewerTaskExtra?: string;
  reviewerProfiles?: ReviewerProfileConfig[];
  reviewConcurrency?: number;
  includeBaselineReview?: boolean;
  fixerAgent?: string;
  fixerSkills?: string[];
  fixerTaskExtra?: string;
  autoFix?: boolean;
  autoFixSuggestions?: boolean;
  blockInputDuringReview?: boolean;
  reviewStartWatchdogMs?: number;
  maxReviewPasses?: number | null;
}

export const MAX_REVIEW_CONCURRENCY = 8;

const DEFAULT_CONFIG: Required<AutoReviewConfig> = {
  enabled: true,
  reviewerAgent: 'reviewer',
  reviewerSkills: [],
  reviewerTaskExtra: '',
  reviewerProfiles: [],
  reviewConcurrency: 4,
  includeBaselineReview: true,
  fixerAgent: 'worker',
  fixerSkills: [],
  fixerTaskExtra: '',
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

function normalizeSkillArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const trimmed = value.map((skill) => typeof skill === 'string' ? skill.trim() : undefined);
  if (trimmed.every((skill): skill is string => typeof skill === 'string' && skill.length > 0)) return trimmed;
  return undefined;
}

function normalizeConfig(value: unknown): AutoReviewConfig {
  if (!value || typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;
  const result: AutoReviewConfig = {};
  if ('enabled' in obj && typeof obj.enabled === 'boolean') result.enabled = obj.enabled;
  if ('reviewerAgent' in obj && typeof obj.reviewerAgent === 'string' && obj.reviewerAgent.trim().length > 0) result.reviewerAgent = obj.reviewerAgent.trim();
  const reviewerSkills = normalizeSkillArray(obj.reviewerSkills);
  if ('reviewerSkills' in obj && reviewerSkills) result.reviewerSkills = reviewerSkills;
  if ('reviewerTaskExtra' in obj && typeof obj.reviewerTaskExtra === 'string') result.reviewerTaskExtra = obj.reviewerTaskExtra;
  const reviewerProfiles = normalizeReviewerProfiles(obj.reviewerProfiles);
  if ('reviewerProfiles' in obj && reviewerProfiles) result.reviewerProfiles = reviewerProfiles;
  if ('reviewConcurrency' in obj && typeof obj.reviewConcurrency === 'number' && Number.isInteger(obj.reviewConcurrency) && obj.reviewConcurrency > 0) {
    result.reviewConcurrency = Math.min(obj.reviewConcurrency, MAX_REVIEW_CONCURRENCY);
  }
  if ('includeBaselineReview' in obj && typeof obj.includeBaselineReview === 'boolean') result.includeBaselineReview = obj.includeBaselineReview;
  if ('fixerAgent' in obj && typeof obj.fixerAgent === 'string' && obj.fixerAgent.trim().length > 0) result.fixerAgent = obj.fixerAgent.trim();
  const fixerSkills = normalizeSkillArray(obj.fixerSkills);
  if ('fixerSkills' in obj && fixerSkills) result.fixerSkills = fixerSkills;
  if ('fixerTaskExtra' in obj && typeof obj.fixerTaskExtra === 'string') result.fixerTaskExtra = obj.fixerTaskExtra;
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
  'reviewerProfiles',
  'reviewConcurrency',
  'includeBaselineReview',
  'fixerAgent',
  'fixerSkills',
  'fixerTaskExtra',
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
    JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
    'utf-8',
  );
}

function isJsonLikeSkillArrayInput(value: string): boolean {
  return /^[\[{\"]/.test(value) || ['true', 'false', 'null'].includes(value);
}

export function parseConfigValue(key: ConfigKey, raw: string): unknown {
  const trimmed = raw.trim();
  if (key === 'enabled' || key === 'includeBaselineReview' || key === 'autoFix' || key === 'autoFixSuggestions' || key === 'blockInputDuringReview') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    throw new Error(`Expected boolean (true/false) for ${key}`);
  }
  if (key === 'reviewStartWatchdogMs' || key === 'reviewConcurrency') {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) throw new Error(`Expected positive number for ${key}`);
    if (key === 'reviewConcurrency') {
      if (!Number.isInteger(num)) throw new Error(`Expected positive integer for ${key}`);
      if (num > MAX_REVIEW_CONCURRENCY) throw new Error(`Expected ${key} to be at most ${MAX_REVIEW_CONCURRENCY}`);
    }
    return num;
  }
  if (key === 'maxReviewPasses') {
    if (['none', 'null', 'unlimited'].includes(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num <= 0) throw new Error(`Expected positive integer or unlimited/null/none for ${key}`);
    return num;
  }
  if (key === 'reviewerProfiles') {
    try {
      const parsed = JSON.parse(trimmed);
      const profiles = normalizeReviewerProfiles(parsed);
      if (profiles) return profiles;
      throw new Error(REVIEWER_PROFILES_PARSE_ERROR);
    } catch (err) {
      if (err instanceof Error && err.message === REVIEWER_PROFILES_PARSE_ERROR) throw err;
      throw new Error(REVIEWER_PROFILES_PARSE_ERROR);
    }
  }
  if (key === 'reviewerSkills' || key === 'fixerSkills') {
    if (trimmed === '[]') return [];
    const skillArrayError = `Expected JSON array or space-separated list for ${key}`;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const skills = normalizeSkillArray(parsed);
        if (skills) return skills;
        throw new Error(`Expected JSON array of non-empty strings for ${key}`);
      }
      if (isJsonLikeSkillArrayInput(trimmed)) throw new Error(skillArrayError);
    } catch (err) {
      if (err instanceof Error && err.message.includes('non-empty strings')) throw err;
      if (isJsonLikeSkillArrayInput(trimmed)) throw new Error(skillArrayError);
      // fall through to shorthand for non-JSON input
    }
    // Accept space-separated list as shorthand
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
    throw new Error(skillArrayError);
  }
  // string fields: reviewerAgent, reviewerTaskExtra, fixerAgent, fixerTaskExtra
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
  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    reviewerProfiles: mergeReviewerProfiles(DEFAULT_CONFIG.reviewerProfiles, globalConfig.reviewerProfiles, projectConfig.reviewerProfiles),
  };
}
