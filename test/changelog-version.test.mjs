import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getLatestChangelogVersion } = require('../tools/changelog-version.cjs');

test('changelog parser returns the latest released version and skips Unreleased', () => {
  const latestRelease = getLatestChangelogVersion(`# Changelog

## [Unreleased]

### Added

- Draft change.

## [2.3.4] - 2026-05-24

### Added

- Latest release.

## [1.0.0] - 2026-01-01

### Added

- Initial release.
`);

  assert.deepEqual(latestRelease, {
    version: '2.3.4',
    date: '2026-05-24',
  });
});

test('changelog parser returns null when no released version is present', () => {
  const latestRelease = getLatestChangelogVersion(`# Changelog

## [Unreleased]

### Added

- Draft change.
`);

  assert.equal(latestRelease, null);
});
