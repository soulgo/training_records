export const DEFAULT_THOUGHT_MODULE = 'workout';

const THOUGHT_MODULES = {
  workout: {
    key: 'workout',
    labels: new Set(['锻炼', '锻炼随想']),
    tags: ['训练', '随想', 'Telegram'],
  },
  misc: {
    key: 'misc',
    labels: new Set(['杂七杂八']),
    tags: ['杂七杂八', '随想', 'Telegram'],
  },
  body_feedback: {
    key: 'body_feedback',
    labels: new Set(['身体反馈']),
    tags: ['身体反馈', '随想', 'Telegram'],
  },
};

export function resolveThoughtModuleLabel(label) {
  const normalized = String(label ?? '').trim();
  for (const module of Object.values(THOUGHT_MODULES)) {
    if (module.labels.has(normalized)) {
      return module.key;
    }
  }
  return null;
}

export function normalizeThoughtModule(value) {
  return THOUGHT_MODULES[value]?.key ?? DEFAULT_THOUGHT_MODULE;
}

export function normalizeThoughtModuleOrNull(value) {
  return THOUGHT_MODULES[value]?.key ?? null;
}

export function getThoughtModuleTags(moduleKey) {
  return [...(THOUGHT_MODULES[normalizeThoughtModule(moduleKey)]?.tags ?? THOUGHT_MODULES.workout.tags)];
}

export function isThoughtBatchKind(kind) {
  return kind === 'thought' || kind === 'thought_edit' || kind === 'thought_delete' || kind === 'thought_move';
}
