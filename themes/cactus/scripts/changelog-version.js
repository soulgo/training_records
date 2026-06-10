const { readLatestChangelogVersion } = require('../../../tools/changelog-version.cjs');

hexo.extend.helper.register('siteVersion', function () {
  const latestRelease = readLatestChangelogVersion(hexo.base_dir);

  return latestRelease ? latestRelease.version : '';
});
