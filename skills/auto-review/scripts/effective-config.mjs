#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_REVIEW_CONCURRENCY = 8;

const DEFAULT_CONFIG = {
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

function loadConfigFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const trimmed = value.map((item) => typeof item === 'string' ? item.trim() : undefined);
  return trimmed.every((item) => typeof item === 'string' && item.length > 0) ? trimmed : undefined;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeReviewerProfiles(value) {
  if (!Array.isArray(value)) return undefined;
  const profiles = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const id = normalizeNonEmptyString(item.id);
    if (!id) return undefined;

    const profile = { id };
    for (const key of ['agent', 'model', 'label', 'task', 'taskExtra']) {
      if (key in item) {
        const normalized = normalizeNonEmptyString(item[key]);
        if (!normalized) return undefined;
        profile[key] = normalized;
      }
    }
    if ('enabled' in item) {
      if (typeof item.enabled !== 'boolean') return undefined;
      profile.enabled = item.enabled;
    }
    if ('skills' in item) {
      const skills = normalizeStringArray(item.skills);
      if (!skills) return undefined;
      profile.skills = skills;
    }
    profiles.push(profile);
  }

  return profiles;
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  if (typeof value.reviewerAgent === 'string' && value.reviewerAgent.trim()) result.reviewerAgent = value.reviewerAgent.trim();
  if ('reviewerSkills' in value) {
    const skills = normalizeStringArray(value.reviewerSkills);
    if (skills) result.reviewerSkills = skills;
  }
  if (typeof value.reviewerTaskExtra === 'string') result.reviewerTaskExtra = value.reviewerTaskExtra;
  if ('reviewerProfiles' in value) {
    const profiles = normalizeReviewerProfiles(value.reviewerProfiles);
    if (profiles) result.reviewerProfiles = profiles;
  }
  if (Number.isInteger(value.reviewConcurrency) && value.reviewConcurrency > 0) {
    result.reviewConcurrency = Math.min(value.reviewConcurrency, MAX_REVIEW_CONCURRENCY);
  }
  if (typeof value.includeBaselineReview === 'boolean') result.includeBaselineReview = value.includeBaselineReview;
  if (typeof value.fixerAgent === 'string' && value.fixerAgent.trim()) result.fixerAgent = value.fixerAgent.trim();
  if ('fixerSkills' in value) {
    const skills = normalizeStringArray(value.fixerSkills);
    if (skills) result.fixerSkills = skills;
  }
  if (typeof value.fixerTaskExtra === 'string') result.fixerTaskExtra = value.fixerTaskExtra;
  if (typeof value.autoFix === 'boolean') result.autoFix = value.autoFix;
  if (typeof value.autoFixSuggestions === 'boolean') result.autoFixSuggestions = value.autoFixSuggestions;
  if (typeof value.blockInputDuringReview === 'boolean') result.blockInputDuringReview = value.blockInputDuringReview;
  if (Number.isFinite(value.reviewStartWatchdogMs) && value.reviewStartWatchdogMs > 0) result.reviewStartWatchdogMs = value.reviewStartWatchdogMs;
  if (value.maxReviewPasses === null) result.maxReviewPasses = null;
  if (Number.isInteger(value.maxReviewPasses) && value.maxReviewPasses > 0) result.maxReviewPasses = value.maxReviewPasses;
  return result;
}

function mergeReviewerProfiles(...profileLists) {
  const merged = new Map();
  for (const profiles of profileLists) {
    for (const profile of profiles ?? []) {
      const existing = merged.get(profile.id);
      merged.set(profile.id, existing ? { ...existing, ...profile } : { ...profile });
    }
  }
  return Array.from(merged.values());
}

function projectConfigPath(root) {
  return path.join(root, '.pi', 'extensions', 'auto-review', 'config.json');
}

function readProjectConfig(cwd, extraRoots = []) {
  const candidates = [cwd, ...extraRoots];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 20; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!candidates.includes(parent)) candidates.push(parent);
    dir = parent;
  }
  for (const root of candidates) {
    const config = normalizeConfig(loadConfigFile(projectConfigPath(root)));
    if (Object.keys(config).length > 0) return config;
  }
  return {};
}

function resolveProjectConfigRoots(cwd) {
  try {
    const commonDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (!commonDir) return [];
    const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
    const mainRoot = path.dirname(absolute);
    return mainRoot && path.resolve(mainRoot) !== path.resolve(cwd) ? [mainRoot] : [];
  } catch {
    return [];
  }
}

function getEffectiveConfig(cwd = process.cwd(), homeDir = os.homedir()) {
  const globalConfig = normalizeConfig(loadConfigFile(path.join(homeDir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json')));
  const projectConfig = readProjectConfig(cwd, resolveProjectConfigRoots(cwd));
  const effective = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    reviewerProfiles: mergeReviewerProfiles(DEFAULT_CONFIG.reviewerProfiles, globalConfig.reviewerProfiles, projectConfig.reviewerProfiles),
  };
  delete effective.blockInputDuringReview;
  delete effective.reviewStartWatchdogMs;
  effective.reviewerProfiles = effective.reviewerProfiles.filter((profile) => profile.enabled !== false);
  return effective;
}

const [cwd = process.cwd(), homeDir = os.homedir()] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify(getEffectiveConfig(path.resolve(cwd), homeDir), null, 2)}\n`);
