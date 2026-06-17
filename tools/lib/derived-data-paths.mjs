export const DERIVED_DATA_PATTERNS = [
  '训练记录.md',
  'source/_data/**',
  'source/_posts/*-telegram-thought-*.md',
  'source/_posts/*-feishu-thought-*.md',
  'source/images/thoughts/**',
];

const TELEGRAM_THOUGHT_POST_RE = /^source\/_posts\/[^/]*-telegram-thought-\d+\.md$/u;
const FEISHU_THOUGHT_POST_RE = /^source\/_posts\/[^/]*-feishu-thought-\d+\.md$/u;
const SOURCE_DATA_RE = /^source\/_data(?:\/|$)/u;
const THOUGHT_IMAGE_RE = /^source\/images\/thoughts(?:\/|$)/u;

export function normalizeGitPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/u, '');
}

export function isDerivedDataPath(value) {
  const gitPath = normalizeGitPath(value);
  return gitPath === '训练记录.md' ||
    SOURCE_DATA_RE.test(gitPath) ||
    TELEGRAM_THOUGHT_POST_RE.test(gitPath) ||
    FEISHU_THOUGHT_POST_RE.test(gitPath) ||
    THOUGHT_IMAGE_RE.test(gitPath);
}

export function filterDerivedDataPaths(paths) {
  return [...new Set((paths ?? []).map(normalizeGitPath).filter(isDerivedDataPath))].sort();
}
