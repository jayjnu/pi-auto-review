export interface ReviewerProfileConfig {
  id: string;
  agent?: string;
  model?: string;
  skills?: string[];
  /** Non-empty task creates a standalone reviewer task; project overrides may omit it to inherit by id. */
  task?: string;
  taskExtra?: string;
  label?: string;
  enabled?: boolean;
}

export const REVIEWER_PROFILES_PARSE_ERROR = 'Expected JSON array of reviewer profile objects with non-empty string id; optional agent/model/label/task/taskExtra must be non-empty strings when present, skills must be an array of non-empty strings, and enabled must be boolean when present';

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const trimmed = value.map((item) => typeof item === 'string' ? item.trim() : undefined);
  if (trimmed.every((item): item is string => typeof item === 'string' && item.length > 0)) return trimmed;
  return undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeReviewerProfiles(value: unknown): ReviewerProfileConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const profiles: ReviewerProfileConfig[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const obj = item as Record<string, unknown>;
    const id = normalizeNonEmptyString(obj.id);
    if (!id) return undefined;

    const profile: ReviewerProfileConfig = { id };
    const agent = normalizeNonEmptyString(obj.agent);
    if ('agent' in obj) {
      if (!agent) return undefined;
      profile.agent = agent;
    }
    const model = normalizeNonEmptyString(obj.model);
    if ('model' in obj) {
      if (!model) return undefined;
      profile.model = model;
    }
    const label = normalizeNonEmptyString(obj.label);
    if ('label' in obj) {
      if (!label) return undefined;
      profile.label = label;
    }
    const task = normalizeNonEmptyString(obj.task);
    if ('task' in obj) {
      if (!task) return undefined;
      profile.task = task;
    }
    const taskExtra = normalizeNonEmptyString(obj.taskExtra);
    if ('taskExtra' in obj) {
      if (!taskExtra) return undefined;
      profile.taskExtra = taskExtra;
    }
    if ('enabled' in obj) {
      if (typeof obj.enabled !== 'boolean') return undefined;
      profile.enabled = obj.enabled;
    }
    const skills = normalizeStringArray(obj.skills);
    if ('skills' in obj) {
      if (!skills) return undefined;
      profile.skills = skills;
    }
    profiles.push(profile);
  }

  return profiles;
}

export function mergeReviewerProfiles(...profileLists: Array<ReviewerProfileConfig[] | undefined>): ReviewerProfileConfig[] {
  const merged = new Map<string, ReviewerProfileConfig>();
  for (const profiles of profileLists) {
    for (const profile of profiles ?? []) {
      const existing = merged.get(profile.id);
      merged.set(profile.id, existing ? { ...existing, ...profile } : { ...profile });
    }
  }
  return Array.from(merged.values());
}
