import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

test('thought module pages split thought posts by thought_module', () => {
  withSharedSiteFixture(() => {
    const workoutPostPath = path.join(rootDir, 'source', '_posts', '2026-05-14-telegram-thought-501.md');
    const miscPostPath = path.join(rootDir, 'source', '_posts', '2026-05-15-telegram-thought-601.md');
    const bodyFeedbackPostPath = path.join(rootDir, 'source', '_posts', '2026-05-16-telegram-thought-701.md');
    const originalWorkoutPost = readOptionalFile(workoutPostPath);
    const originalMiscPost = readOptionalFile(miscPostPath);
    const originalBodyFeedbackPost = readOptionalFile(bodyFeedbackPostPath);

    try {
      writeFileSync(
        workoutPostPath,
        `---
date: 2026-05-14 10:30:00
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 501
telegram_chat_id: 42
---

锻炼模块默认随想
`,
        'utf8',
      );
      writeFileSync(
        miscPostPath,
        `---
date: 2026-05-15 10:30:00
tags:
  - 杂七杂八
  - 随想
  - Telegram
thought_module: misc
telegram_message_id: 601
telegram_chat_id: 42
---

杂七杂八模块随想
`,
        'utf8',
      );
      writeFileSync(
        bodyFeedbackPostPath,
        `---
date: 2026-05-16 10:30:00
tags:
  - 身体反馈
  - 随想
  - Telegram
thought_module: body_feedback
telegram_message_id: 701
telegram_chat_id: 42
---

身体反馈模块随想
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
      const miscIndex = readFileSync(path.join(rootDir, 'public', 'misc', 'index.html'), 'utf8');
      const bodyFeedbackIndex = readFileSync(path.join(rootDir, 'public', 'body-feedback', 'index.html'), 'utf8');
      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

      assert.match(thoughtsIndex, /锻炼模块默认随想/);
      assert.doesNotMatch(thoughtsIndex, /杂七杂八模块随想/);
      assert.doesNotMatch(thoughtsIndex, /身体反馈模块随想/);
      assert.match(miscIndex, /杂七杂八模块随想/);
      assert.doesNotMatch(miscIndex, /锻炼模块默认随想/);
      assert.doesNotMatch(miscIndex, /身体反馈模块随想/);
      assert.match(bodyFeedbackIndex, /身体反馈模块随想/);
      assert.doesNotMatch(bodyFeedbackIndex, /锻炼模块默认随想/);
      assert.doesNotMatch(bodyFeedbackIndex, /杂七杂八模块随想/);
      assert.doesNotMatch(homepage, /锻炼模块默认随想/);
      assert.doesNotMatch(homepage, /杂七杂八模块随想/);
      assert.doesNotMatch(homepage, /身体反馈模块随想/);
    } finally {
      restoreOptionalFile(workoutPostPath, originalWorkoutPost);
      restoreOptionalFile(miscPostPath, originalMiscPost);
      restoreOptionalFile(bodyFeedbackPostPath, originalBodyFeedbackPost);
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

test('thoughts page renders markdown document content from telegram thoughts', () => {
  withSharedSiteFixture(() => {
    const thoughtPostPath = path.join(rootDir, 'source', '_posts', '2026-05-14-telegram-thought-503.md');
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
telegram_message_id: 503
telegram_chat_id: 42
---

## Markdown 附件标题

- 动作路线更稳定
- 恢复节奏更清晰

\`\`\`text
RPE 7
\`\`\`

[训练记录链接](/training/)
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

      assert.match(thoughtsIndex, /<h2[^>]*>[\s\S]*Markdown 附件标题<\/h2>/);
      assert.match(thoughtsIndex, /<li>动作路线更稳定<\/li>/);
      assert.match(thoughtsIndex, /RPE 7/);
      assert.match(thoughtsIndex, /href="\/training\/"/);
    } finally {
      restoreOptionalFile(thoughtPostPath, originalThoughtPost);
    }
  });
});

test('thoughts page and detail page render telegram thought photos', () => {
  withSharedSiteFixture(() => {
    const thoughtPostPath = path.join(rootDir, 'source', '_posts', '2026-05-14-telegram-thought-502.md');
    const imagePath = path.join(
      rootDir,
      'source',
      'images',
      'thoughts',
      '2026',
      '05',
      '2026-05-14-telegram-thought-502-1.jpg',
    );
    const originalThoughtPost = readOptionalFile(thoughtPostPath);
    const originalImage = readOptionalFile(imagePath);

    try {
      writeFileSync(
        thoughtPostPath,
        `---
date: 2026-05-14 10:30:00
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 502
telegram_chat_id: 42
photos:
  - /images/thoughts/2026/05/2026-05-14-telegram-thought-502-1.jpg
---

今天深蹲动作轨迹更稳了
`,
        'utf8',
      );
      mkdirSync(path.dirname(imagePath), { recursive: true });
      writeFileSync(imagePath, 'fake image content', 'utf8');

      execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const thoughtsIndex = readFileSync(path.join(rootDir, 'public', 'thoughts', 'index.html'), 'utf8');
      const detailPage = readFileSync(
        path.join(rootDir, 'public', 'thoughts', '2026', '05', '14', '2026-05-14-telegram-thought-502', 'index.html'),
        'utf8',
      );

      assert.match(thoughtsIndex, /class="thought-card__photos"/);
      assert.match(thoughtsIndex, /src="\/images\/thoughts\/2026\/05\/2026-05-14-telegram-thought-502-1\.jpg"/);
      assert.match(detailPage, /class="article-gallery"/);
      assert.match(detailPage, /href="\/images\/thoughts\/2026\/05\/2026-05-14-telegram-thought-502-1\.jpg"/);
    } finally {
      restoreOptionalFile(thoughtPostPath, originalThoughtPost);
      restoreOptionalFile(imagePath, originalImage);
    }
  });
});

test('thoughts page shows telegram message ids for telegram thoughts', () => {
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

      assert.match(thoughtsIndex, /class="thought-card__id"[^>]*>#501<\/span>/);
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
