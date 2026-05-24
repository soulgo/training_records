const { readFileSync } = require('node:fs');
const path = require('node:path');

const releaseHeadingPattern =
  /^## \[([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})(?: \[YANKED\])?\s*$/m;

function getLatestChangelogVersion(changelog) {
  const match = changelog.match(releaseHeadingPattern);

  if (!match) {
    return null;
  }

  return {
    version: match[1],
    date: match[2],
  };
}

function readLatestChangelogVersion(rootDir) {
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');

  return getLatestChangelogVersion(changelog);
}

module.exports = {
  getLatestChangelogVersion,
  readLatestChangelogVersion,
};
