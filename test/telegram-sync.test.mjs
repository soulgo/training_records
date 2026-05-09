import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrainingRecord } from '../tools/training-parser.mjs';

async function importTelegramSyncLib() {
  try {
    return await import('../tools/telegram-sync-lib.mjs');
  } catch {
    return null;
  }
}

test('groups album messages and prefers caption date for the whole batch', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');
  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const updates = [
    {
      update_id: 101,
      message: {
        message_id: 1,
        media_group_id: 'album-1',
        date: 1_746_748_800,
        caption: '归档到 2026-05-09，今天晚餐',
        chat: { id: 42 },
        photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
      },
    },
    {
      update_id: 102,
      message: {
        message_id: 2,
        media_group_id: 'album-1',
        date: 1_746_748_900,
        chat: { id: 42 },
        photo: [{ file_id: 'file-b', file_unique_id: 'uniq-b' }],
      },
    },
    {
      update_id: 103,
      message: {
        message_id: 3,
        date: 1_746_749_000,
        caption: '2026-05-10 晨起体脂秤',
        chat: { id: 42 },
        photo: [{ file_id: 'file-c', file_unique_id: 'uniq-c' }],
      },
    },
  ];

  const batches = lib.groupTelegramUpdates(updates);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].messages.length, 2);
  assert.equal(batches[1].messages.length, 1);

  const analyzed = lib.analyzeTelegramBatch(batches[0], [
    {
      messageId: 1,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'caption',
      confidence: 0.97,
      warnings: [],
      records: {
        meals: [
          { name: '晚餐', calories: 308, recommendedMin: 311, recommendedMax: 725 },
        ],
        totalCalories: 308,
      },
    },
    {
      messageId: 2,
      imageType: 'workout',
      detectedDate: '2026-05-08',
      dateEvidence: 'ocr',
      confidence: 0.85,
      warnings: [],
      records: {
        activities: [
          {
            time: '19:12',
            type: '力量训练',
            detail: '20分49秒，消耗189千卡，平均132次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-09');
  assert.equal(analyzed.nutrition.totalCalories, 308);
  assert.equal(analyzed.activities.length, 1);
});

test('skips writeback when a batch has conflicting detected dates without caption override', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-2',
    messages: [
      {
        updateId: 201,
        messageId: 21,
        mediaGroupId: 'album-2',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: 1_746_748_800,
        photos: [{ fileId: 'file-d', fileUniqueId: 'uniq-d' }],
      },
      {
        updateId: 202,
        messageId: 22,
        mediaGroupId: 'album-2',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: 1_746_748_900,
        photos: [{ fileId: 'file-e', fileUniqueId: 'uniq-e' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 21,
      imageType: 'measurement',
      detectedDate: '2026-05-08',
      dateEvidence: 'ocr',
      confidence: 0.92,
      warnings: [],
      records: {
        measurement: {
          measuredAt: '2026-05-08 07:10',
          weightKg: 72.8,
          bodyFatPct: 22.4,
        },
      },
    },
    {
      messageId: 22,
      imageType: 'nutrition',
      detectedDate: '2026-05-09',
      dateEvidence: 'ocr',
      confidence: 0.88,
      warnings: [],
      records: {
        meals: [{ name: '早餐', calories: 320, recommendedMin: 400, recommendedMax: 650 }],
        totalCalories: 320,
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.match(analyzed.reason, /conflicting/i);
});

test('writes measurement workout and nutrition into markdown idempotently', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const markdown = `
### 2026-05-07

#### 当日体脂秤截图记录

- 测量时间：2026-05-07 12:35
- 身体得分：77分
- 体重：73.55 kg
- BMI：23.7
- 体脂率：22.4%
- 骨骼肌量：30.9 kg
- 内脏脂肪等级：9.0
- 基础代谢率：1609 kcal/日
`;

  const batchResult = {
    batchId: 'album-3',
    archivedDate: '2026-05-09',
    measurement: {
      measuredAt: '2026-05-09 06:42',
      bodyScore: 74,
      weightKg: 72.85,
      bmi: 23.5,
      bodyFatPct: 22.8,
      skeletalMuscleKg: 30.45,
      visceralFatLevel: 8,
      basalMetabolismKcal: 1587,
    },
    activities: [
      {
        time: '18:25',
        type: '燃脂训练',
        detail: '39分44秒，消耗424千卡，平均145次/分钟',
      },
    ],
    nutrition: {
      meals: [
        { name: '晚餐', calories: 308, recommendedMin: 311, recommendedMax: 725 },
      ],
      totalCalories: 308,
      details: ['鸡胸肉 200g（约220千卡）', '黄瓜 300g（约88千卡）'],
    },
    fingerprints: {
      measurement: ['m-2026-05-09-06:42-72.85-22.8'],
      activities: ['a-2026-05-09-18:25-燃脂训练-424'],
      nutrition: ['n-2026-05-09-晚餐-308'],
    },
  };

  const firstPass = lib.applyTelegramSyncToMarkdown(markdown, batchResult);
  const secondPass = lib.applyTelegramSyncToMarkdown(firstPass.markdown, batchResult);

  assert.equal(firstPass.changed, true);
  assert.equal(secondPass.changed, false);
  assert.equal(secondPass.markdown, firstPass.markdown);

  const parsed = parseTrainingRecord(firstPass.markdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-09');

  assert.ok(day);
  assert.equal(day.measurement?.weightKg, 72.85);
  assert.equal(day.activities.length, 1);
  assert.equal(day.nutrition.totalCalories, 308);
});

test('processes only allowed chats and advances state to the highest processed update id', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.processTelegramUpdates, 'processTelegramUpdates export missing');

  const markdown = `
### 2026-05-08

#### 当日运动截图记录

- 08:16 户外骑行：3.18公里，16分49秒，均速11.35公里/小时
`;

  const updates = [
    {
      update_id: 301,
      message: {
        message_id: 31,
        date: 1_746_748_800,
        chat: { id: 99 },
        caption: '2026-05-09 晚餐',
        photo: [{ file_id: 'skip-file', file_unique_id: 'skip-uniq' }],
      },
    },
    {
      update_id: 302,
      message: {
        message_id: 32,
        media_group_id: 'album-9',
        date: 1_746_748_900,
        chat: { id: 42 },
        caption: '归档到 2026-05-09',
        photo: [{ file_id: 'ok-file-a', file_unique_id: 'ok-uniq-a' }],
      },
    },
    {
      update_id: 303,
      message: {
        message_id: 33,
        media_group_id: 'album-9',
        date: 1_746_749_000,
        chat: { id: 42 },
        photo: [{ file_id: 'ok-file-b', file_unique_id: 'ok-uniq-b' }],
      },
    },
  ];

  const result = await lib.processTelegramUpdates({
    markdown,
    updates,
    allowedChatIds: new Set([42]),
    recognizeBatch: async (batch) =>
      batch.messages.map((message) => ({
        messageId: message.messageId,
        imageType: message.messageId === 32 ? 'nutrition' : 'workout',
        detectedDate: message.messageId === 33 ? '2026-05-08' : null,
        dateEvidence: message.messageId === 32 ? 'caption' : 'ocr',
        confidence: 0.95,
        warnings: [],
        records:
          message.messageId === 32
            ? {
                meals: [
                  {
                    name: '晚餐',
                    calories: 308,
                    recommendedMin: 311,
                    recommendedMax: 725,
                  },
                ],
                totalCalories: 308,
              }
            : {
                activities: [
                  {
                    time: '19:12',
                    type: '力量训练',
                    detail: '20分49秒，消耗189千卡，平均132次/分钟',
                  },
                ],
              },
      })),
  });

  assert.equal(result.changed, true);
  assert.equal(result.lastProcessedUpdateId, 303);
  assert.equal(result.batchResults.length, 2);
  assert.equal(result.batchResults[0].status, 'ignored');
  assert.equal(result.batchResults[1].status, 'ready');
  assert.equal(result.inboxEntries.length, 1);
  assert.match(result.markdown, /2026-05-09 饮食截图记录/);
  assert.match(result.markdown, /19:12 力量训练/);
});
