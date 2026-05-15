import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSharedSiteFixture } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('thoughts page lists posts from source/_posts', () => {
  withSharedSiteFixture(() => {
    execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
      cwd: rootDir,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
      cwd: rootDir,
      stdio: 'pipe',
    });

    const thoughtsIndex = readFileSync(path.join(rootDir, 'public', 'thoughts', 'index.html'), 'utf8');

    assert.match(thoughtsIndex, /昨晚燃脂 \+ 哑铃力量训练锻炼完以后，屁股有点疼，不知道是啥原因？/);
    assert.doesNotMatch(thoughtsIndex, /燃脂和哑铃力量训练后屁股有点疼/);
    assert.doesNotMatch(thoughtsIndex, /你可以手工在/);
    assert.doesNotMatch(thoughtsIndex, /阅读全文/);
    assert.doesNotMatch(thoughtsIndex, /还没有锻炼随想/);
  });
});

test('thoughts page only lists posts tagged with 随想 and excludes them from homepage and archives', () => {
  withSharedSiteFixture(() => {
    const extraPostPath = path.join(rootDir, 'source', '_posts', '2026-05-10-non-thought-note.md');
    const originalExtraPost = readOptionalFile(extraPostPath);

    try {
      writeFileSync(
        extraPostPath,
        `---
title: 普通记录文章
date: 2026-05-10 09:00:00
tags:
  - 训练
---

这是一篇不带随想标签的普通文章。
`,
        'utf8',
      );

      execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const thoughtsIndex = readFileSync(path.join(rootDir, 'public', 'thoughts', 'index.html'), 'utf8');
      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
      const regularPostPagePath = path.join(
        rootDir,
        'public',
        'thoughts',
        '2026',
        '05',
        '10',
        '2026-05-10-non-thought-note',
        'index.html',
      );
      assert.match(thoughtsIndex, /昨晚燃脂 \+ 哑铃力量训练锻炼完以后，屁股有点疼，不知道是啥原因？/);
      assert.doesNotMatch(thoughtsIndex, /普通记录文章/);
      assert.doesNotMatch(homepage, /昨晚燃脂 \+ 哑铃力量训练锻炼完以后，屁股有点疼，不知道是啥原因？/);
      assert.equal(existsSync(regularPostPagePath), true);
      assert.equal(existsSync(path.join(rootDir, 'public', 'archives', 'index.html')), false);
    } finally {
      restoreOptionalFile(extraPostPath, originalExtraPost);
    }
  });
});

test('thought detail page hides the title heading for telegram thoughts without front matter title', () => {
  withSharedSiteFixture(() => {
    const thoughtPostPath = path.join(rootDir, 'source', '_posts', '2026-05-14-telegram-thought-501.md');
    const originalThoughtPost = readOptionalFile(thoughtPostPath);

    try {
      writeFileSync(
        thoughtPostPath,
        `---
date: 2026-05-14 10:30:00
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 501
telegram_chat_id: 42
---

今天训练后臀部发力更明显
感觉动作路线更顺了
`,
        'utf8',
      );

      execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const detailPage = readFileSync(
        path.join(rootDir, 'public', 'thoughts', '2026', '05', '14', '2026-05-14-telegram-thought-501', 'index.html'),
        'utf8',
      );

      assert.doesNotMatch(detailPage, /<h1 class="posttitle p-name" itemprop="name headline">/);
      assert.match(detailPage, /今天训练后臀部发力更明显/);
    } finally {
      restoreOptionalFile(thoughtPostPath, originalThoughtPost);
    }
  });
});

function readOptionalFile(targetPath) {
  try {
    return readFileSync(targetPath, 'utf8');
  } catch {
    return null;
  }
}

function restoreOptionalFile(targetPath, content) {
  if (content === null) {
    rmSync(targetPath, { force: true });
    return;
  }

  writeFileSync(targetPath, content, 'utf8');
}
