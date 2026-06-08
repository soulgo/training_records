export const DERIVED_DATA_PATTERNS = [
  '训练记录.md',
  'source/_posts/*-telegram-thought-*.md',
  'source/images/thoughts/**',
];

const TELEGRAM_THOUGHT_POST_RE = /^source\/_posts\/[^/]*-telegram-thought-\d+\.md$/u;
const THOUGHT_IMAGE_RE = /^source\/images\/thoughts(?:\/|$)/u;

export function normalizeGitPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/u, '');
}

export function isDerivedDataPath(value) {
  const gitPath = normalizeGitPath(value);
  return gitPath === '训练记录.md' ||
    TELEGRAM_THOUGHT_POST_RE.test(gitPath) ||
    THOUGHT_IMAGE_RE.test(gitPath);
}

export function filterDerivedDataPaths(paths) {
  return [...new Set((paths ?? []).map(normalizeGitPath).filter(isDerivedDataPath))].sort();
}
