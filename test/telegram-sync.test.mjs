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

async function importTelegramCommandRegistry() {
  try {
    return await import('../src/telegram/command-registry.mjs');
  } catch {
    return null;
  }
}

test('groups album document images and applies filename date when screenshots are undated', async () => {
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
        chat: { id: 42 },
        document: {
          file_id: 'file-a',
          file_unique_id: 'uniq-a',
          file_name: '饮食记录 2026-05-09.jpg',
          mime_type: 'image/jpeg',
        },
      },
    },
    {
      update_id: 102,
      message: {
        message_id: 2,
        media_group_id: 'album-1',
        date: 1_746_748_900,
        chat: { id: 42 },
        document: {
          file_id: 'file-b',
          file_unique_id: 'uniq-b',
          file_name: '2026_05_09 运动截图.png',
          mime_type: 'image/png',
        },
      },
    },
    {
      update_id: 103,
      message: {
        message_id: 3,
        date: 1_746_749_000,
        chat: { id: 42 },
        photo: [{ file_id: 'file-c', file_unique_id: 'uniq-c' }],
      },
    },
  ];

  const batches = lib.groupTelegramUpdates(updates);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'image');
  assert.equal(batches[0].messages.length, 2);
  assert.equal(batches[1].messages.length, 1);

  const analyzed = lib.analyzeTelegramBatch(batches[0], [
    {
      messageId: 1,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible image date',
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
      detectedDate: null,
      dateEvidence: 'no visible date',
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

test('uses meal calories as nutrition total when recognition omits totalCalories', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');
  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const updates = [
    {
      update_id: 151,
      message: {
        message_id: 51,
        media_group_id: 'album-meal-total',
        date: 1_748_044_800,
        chat: { id: 42 },
        document: {
          file_id: 'file-a',
          file_unique_id: 'uniq-a',
          file_name: '饮食记录 2026-05-24.jpg',
          mime_type: 'image/jpeg',
        },
      },
    },
  ];

  const [batch] = lib.groupTelegramUpdates(updates);
  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 51,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible image date',
      confidence: 0.97,
      warnings: ['仅显示餐次汇总与食物明细，未见当日总热量'],
      records: {
        measurement: null,
        activities: [],
        meals: [
          { name: '午餐', calories: 580, recommendedMin: 616, recommendedMax: 1026 },
          { name: '早餐', calories: 114, recommendedMin: 513, recommendedMax: 924 },
          { name: '晚餐', calories: 244, recommendedMin: 308, recommendedMax: 719 },
        ],
        totalCalories: null,
        details: [],
        dailyWorkoutSummary: null,
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-24');
  assert.equal(analyzed.nutrition.totalCalories, 938);
});

test('groups /thought and /随想 messages into thought batches and ignores normal text', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const updates = [
    {
      update_id: 201,
      message: {
        message_id: 11,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/thought 今天训练后臀部发力更明显\n感觉动作路线更顺了',
      },
    },
    {
      update_id: 202,
      message: {
        message_id: 12,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/随想 恢复节奏更稳了',
      },
    },
    {
      update_id: 203,
      message: {
        message_id: 13,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/thoughts 这个不应该被识别',
      },
    },
    {
      update_id: 204,
      message: {
        message_id: 14,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '只是普通文本',
      },
    },
  ];

  const batches = lib.groupTelegramUpdates(updates);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'thought');
  assert.equal(batches[0].batchId, 'thought-11');
  assert.equal(batches[0].thought.command, '/thought');
  assert.equal(batches[0].thought.body, '今天训练后臀部发力更明显\n感觉动作路线更顺了');
  assert.equal(batches[0].thought.thoughtModule, 'workout');
  assert.equal(batches[1].kind, 'thought');
  assert.equal(batches[1].batchId, 'thought-12');
  assert.equal(batches[1].thought.command, '/随想');
  assert.equal(batches[1].thought.body, '恢复节奏更稳了');
  assert.equal(batches[1].thought.thoughtModule, 'workout');
});

test('groups module-scoped thought commands into module-specific thought batches', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 205,
      message: {
        message_id: 15,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/随想 杂七杂八 今天整理了一堆没来得及记的事',
      },
    },
    {
      update_id: 206,
      message: {
        message_id: 16,
        date: 1_746_748_801,
        chat: { id: 42 },
        text: '/thought 锻炼 今天腿练得很实',
      },
    },
    {
      update_id: 207,
      message: {
        message_id: 17,
        date: 1_746_748_802,
        chat: { id: 42 },
        text: '/随想 身体反馈 今天硬拉后右侧腰背有点刺痛',
      },
    },
  ]);

  assert.equal(batches.length, 3);
  assert.equal(batches[0].thought.thoughtModule, 'misc');
  assert.equal(batches[0].thought.body, '今天整理了一堆没来得及记的事');
  assert.equal(batches[1].thought.thoughtModule, 'workout');
  assert.equal(batches[1].thought.body, '今天腿练得很实');
  assert.equal(batches[2].thought.thoughtModule, 'body_feedback');
  assert.equal(batches[2].thought.body, '今天硬拉后右侧腰背有点刺痛');
});

test('groups thought captions with images and albums without treating them as training screenshots', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 211,
      message: {
        message_id: 31,
        date: 1_746_748_800,
        chat: { id: 42 },
        caption: '/随想 杂七杂八 今天训练后的动作截图',
        photo: [
          { file_id: 'small', file_unique_id: 'small-u', width: 90, height: 90, file_size: 1000 },
          { file_id: 'large', file_unique_id: 'large-u', width: 1280, height: 960, file_size: 8000 },
        ],
      },
    },
    {
      update_id: 212,
      message: {
        message_id: 32,
        media_group_id: 'album-thought',
        date: 1_746_748_810,
        chat: { id: 42 },
        caption: '/thought 相册随想',
        photo: [{ file_id: 'album-a', file_unique_id: 'album-a-u' }],
      },
    },
    {
      update_id: 213,
      message: {
        message_id: 33,
        media_group_id: 'album-thought',
        date: 1_746_748_811,
        chat: { id: 42 },
        photo: [{ file_id: 'album-b', file_unique_id: 'album-b-u' }],
      },
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'thought');
  assert.equal(batches[0].batchId, 'thought-31');
  assert.equal(batches[0].thought.command, '/随想');
  assert.equal(batches[0].thought.thoughtModule, 'misc');
  assert.equal(batches[0].messages.length, 1);
  assert.equal(batches[1].kind, 'thought');
  assert.equal(batches[1].batchId, 'thought-32');
  assert.equal(batches[1].thought.command, '/thought');
  assert.equal(batches[1].thought.thoughtModule, 'workout');
  assert.equal(batches[1].messages.length, 2);
});

test('groups /analysis text messages into analysis batches', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 301,
      message: {
        message_id: 21,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/analysis 今天怎么练',
      },
    },
    {
      update_id: 302,
      message: {
        message_id: 22,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/分析 最近饮食怎么样',
      },
    },
    {
      update_id: 303,
      message: {
        message_id: 23,
        date: 1_746_749_000,
        chat: { id: 42 },
        text: '只是普通文本',
      },
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'analysis');
  assert.equal(batches[0].batchId, 'analysis-21');
  assert.equal(batches[0].analysis.command, '/analysis');
  assert.equal(batches[0].analysis.question, '今天怎么练');
  assert.equal(batches[1].kind, 'analysis');
  assert.equal(batches[1].batchId, 'analysis-22');
  assert.equal(batches[1].analysis.command, '/分析');
  assert.equal(batches[1].analysis.question, '最近饮食怎么样');
});

test('groups /ai text messages into ai agent batches', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 321,
      message: {
        message_id: 31,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/ai 搜一下右肩疼痛相关记录',
      },
    },
    {
      update_id: 322,
      message: {
        message_id: 32,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/智能助手 同步状态正常吗',
      },
    },
    {
      update_id: 323,
      message: {
        message_id: 33,
        date: 1_746_749_000,
        chat: { id: 42 },
        text: '/ais 这个不应该被识别',
      },
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'ai_agent');
  assert.equal(batches[0].batchId, 'ai-31');
  assert.equal(batches[0].aiAgent.command, '/ai');
  assert.equal(batches[0].aiAgent.question, '搜一下右肩疼痛相关记录');
  assert.equal(batches[1].kind, 'ai_agent');
  assert.equal(batches[1].batchId, 'ai-32');
  assert.equal(batches[1].aiAgent.command, '/智能助手');
  assert.equal(batches[1].aiAgent.question, '同步状态正常吗');
});

test('groups supported Telegram command aliases without changing routed batch shape', async () => {
  const lib = await importTelegramSyncLib();
  const registry = await importTelegramCommandRegistry();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');
  assert.ok(registry?.getTelegramCommandRegistry, 'getTelegramCommandRegistry export missing');

  const commandRegistry = registry.getTelegramCommandRegistry();
  assert.deepEqual(
    commandRegistry.map((entry) => entry.name),
    ['help', 'move', 'delete', 'analysis', 'ai_agent', 'explicit_edit', 'edited_message', 'reply_edit', 'thought', 'image'],
  );
  assert.deepEqual(
    commandRegistry.map((entry) => entry.priority),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(commandRegistry[0].aliases, ['/help', '/帮助', 'help', '帮助', '命令', '指令', '使用说明']);
  assert.deepEqual(commandRegistry[1].aliases, ['/move', '/移动', '/thought', '/随想']);
  assert.deepEqual(commandRegistry[2].aliases, ['/thought-delete', '/thoughtdel', '/delete-thought', '/删随想', '/随想删']);
  assert.deepEqual(commandRegistry[3].aliases, ['/analysis', '/分析']);
  assert.deepEqual(commandRegistry[4].aliases, ['/ai', '/智能助手']);
  assert.deepEqual(commandRegistry[5].aliases, ['/thought-edit', '/thoughtedit', '/edit-thought', '/编随想', '/随想编']);
  assert.deepEqual(commandRegistry[8].aliases, ['/thought', '/随想']);

  const fixtures = [
    {
      text: '/thought-edit 126 修订后的正文',
      kind: 'thought_edit',
      payloadKey: 'thoughtEdit',
      command: '/thought-edit',
      targetMessageId: 126,
      body: '修订后的正文',
    },
    {
      text: '/thoughtedit 127 修订后的正文',
      kind: 'thought_edit',
      payloadKey: 'thoughtEdit',
      command: '/thoughtedit',
      targetMessageId: 127,
      body: '修订后的正文',
    },
    {
      text: '/edit-thought 128 杂七杂八 修订后的正文',
      kind: 'thought_edit',
      payloadKey: 'thoughtEdit',
      command: '/edit-thought',
      targetMessageId: 128,
      body: '修订后的正文',
      thoughtModule: 'misc',
    },
    {
      text: '/编随想 129 修订后的正文',
      kind: 'thought_edit',
      payloadKey: 'thoughtEdit',
      command: '/编随想',
      targetMessageId: 129,
      body: '修订后的正文',
    },
    {
      text: '/随想编 130 锻炼 修订后的正文',
      kind: 'thought_edit',
      payloadKey: 'thoughtEdit',
      command: '/随想编',
      targetMessageId: 130,
      body: '修订后的正文',
      thoughtModule: 'workout',
    },
    {
      text: '/thought-delete 126',
      kind: 'thought_delete',
      payloadKey: 'thoughtDelete',
      command: '/thought-delete',
      targetMessageId: 126,
    },
    {
      text: '/thoughtdel 127',
      kind: 'thought_delete',
      payloadKey: 'thoughtDelete',
      command: '/thoughtdel',
      targetMessageId: 127,
    },
    {
      text: '/delete-thought 128',
      kind: 'thought_delete',
      payloadKey: 'thoughtDelete',
      command: '/delete-thought',
      targetMessageId: 128,
    },
    {
      text: '/删随想 129',
      kind: 'thought_delete',
      payloadKey: 'thoughtDelete',
      command: '/删随想',
      targetMessageId: 129,
    },
    {
      text: '/随想删 130',
      kind: 'thought_delete',
      payloadKey: 'thoughtDelete',
      command: '/随想删',
      targetMessageId: 130,
    },
    {
      text: '/move 126 杂七杂八',
      kind: 'thought_move',
      payloadKey: 'thoughtMove',
      command: '/move',
      targetMessageId: 126,
      thoughtModule: 'misc',
    },
    {
      text: '/移动 131 身体反馈',
      kind: 'thought_move',
      payloadKey: 'thoughtMove',
      command: '/移动',
      targetMessageId: 131,
      thoughtModule: 'body_feedback',
    },
    {
      text: '/移动 127 锻炼',
      kind: 'thought_move',
      payloadKey: 'thoughtMove',
      command: '/移动',
      targetMessageId: 127,
      thoughtModule: 'workout',
    },
    {
      text: '/analysis 今天怎么练',
      kind: 'analysis',
      payloadKey: 'analysis',
      command: '/analysis',
      question: '今天怎么练',
    },
    {
      text: '/分析 最近饮食怎么样',
      kind: 'analysis',
      payloadKey: 'analysis',
      command: '/分析',
      question: '最近饮食怎么样',
    },
    {
      text: '/ai 搜一下右肩疼痛相关记录',
      kind: 'ai_agent',
      payloadKey: 'aiAgent',
      command: '/ai',
      question: '搜一下右肩疼痛相关记录',
    },
    {
      text: '/智能助手 同步状态正常吗',
      kind: 'ai_agent',
      payloadKey: 'aiAgent',
      command: '/智能助手',
      question: '同步状态正常吗',
    },
    {
      text: '/帮助',
      kind: 'help',
      payloadKey: 'help',
      command: '/帮助',
    },
    {
      text: 'help',
      kind: 'help',
      payloadKey: 'help',
      command: 'help',
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const messageId = 800 + index;
    const [batch] = lib.groupTelegramUpdates([
      {
        update_id: 700 + index,
        message: {
          message_id: messageId,
          date: 1_746_748_800 + index,
          chat: { id: 42 },
          text: fixture.text,
        },
      },
    ]);

    assert.ok(batch, `expected batch for ${fixture.text}`);
    assert.equal(batch.kind, fixture.kind, fixture.text);
    assert.deepEqual(
      Object.keys(batch).sort(),
      ['batchId', 'kind', 'messages', fixture.payloadKey].sort(),
      fixture.text,
    );
    assert.equal(batch.messages.length, 1, fixture.text);
    assert.equal(batch.messages[0].messageId, messageId, fixture.text);

    const payload = batch[fixture.payloadKey];
    assert.equal(payload.command, fixture.command, fixture.text);
    if ('targetMessageId' in fixture) {
      assert.equal(payload.targetMessageId, fixture.targetMessageId, fixture.text);
    }
    if ('body' in fixture) {
      assert.equal(payload.body, fixture.body, fixture.text);
    }
    if ('thoughtModule' in fixture) {
      assert.equal(payload.thoughtModule, fixture.thoughtModule, fixture.text);
    }
    if ('question' in fixture) {
      assert.equal(payload.question, fixture.question, fixture.text);
    }
  }
});

test('groups edited thought messages into thought_edit batches when the message is already a known thought', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates(
    [
      {
        update_id: 401,
        edited_message: {
          message_id: 126,
          date: 1_746_748_800,
          chat: { id: 42 },
          text: '今天骑行 40 公里，状态更顺了',
        },
      },
    ],
    {
      knownThoughtMessageKeys: ['42:126'],
    },
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_edit');
  assert.equal(batches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(batches[0].thoughtEdit.body, '今天骑行 40 公里，状态更顺了');
  assert.equal(batches[0].thoughtEdit.thoughtModule, null);
});

test('groups edited thought messages with a module token into thought_edit batches for module updates', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates(
    [
      {
        update_id: 402,
        edited_message: {
          message_id: 126,
          date: 1_746_748_800,
          chat: { id: 42 },
          text: '杂七杂八 今天把杂事也记一下',
        },
      },
    ],
    {
      knownThoughtMessageKeys: ['42:126'],
    },
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_edit');
  assert.equal(batches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(batches[0].thoughtEdit.body, '今天把杂事也记一下');
  assert.equal(batches[0].thoughtEdit.thoughtModule, 'misc');
});

test('groups reply-based thought revisions into thought_edit batches when replying to a known thought', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 402,
      message: {
        message_id: 131,
        date: 1_746_748_800,
        chat: { id: 42 },
        reply_to_message: {
          message_id: 126,
        },
        text: '/随想 今天骑行 40 公里，温地公园是一个散步的好地方，\n高德地图骑行的公里数和华为手表骑行的公里数差别太大了，差了12公里多。',
      },
    },
  ], {
    knownThoughtMessageKeys: ['42:126'],
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_edit');
  assert.equal(batches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(
    batches[0].thoughtEdit.body,
    '今天骑行 40 公里，温地公园是一个散步的好地方，\n高德地图骑行的公里数和华为手表骑行的公里数差别太大了，差了12公里多。',
  );
  assert.equal(batches[0].thoughtEdit.thoughtModule, null);
});

test('groups explicit thought edit commands by target message id', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 403,
      message: {
        message_id: 132,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/随想编 126 今天骑行 40 公里，补充一下高德和手表差了12公里多。',
      },
    },
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_edit');
  assert.equal(batches[0].thoughtEdit.command, '/随想编');
  assert.equal(batches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(batches[0].thoughtEdit.body, '今天骑行 40 公里，补充一下高德和手表差了12公里多。');
});

test('groups explicit thought edit captions with images as photo replacement edits', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 404,
      message: {
        message_id: 133,
        date: 1_746_748_800,
        chat: { id: 42 },
        caption: '/随想编 126 更新正文并替换图片',
        photo: [{ file_id: 'new-photo', file_unique_id: 'new-photo-u' }],
      },
    },
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_edit');
  assert.equal(batches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(batches[0].thoughtEdit.body, '更新正文并替换图片');
  assert.equal(batches[0].thoughtEdit.replacePhotos, true);
});

test('groups thought delete commands by reply target and explicit message id', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 411,
      message: {
        message_id: 701,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/随想删',
        reply_to_message: {
          message_id: 126,
        },
      },
    },
    {
      update_id: 412,
      message: {
        message_id: 702,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/随想删 127',
      },
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'thought_delete');
  assert.equal(batches[0].thoughtDelete.targetMessageId, 126);
  assert.equal(batches[1].kind, 'thought_delete');
  assert.equal(batches[1].thoughtDelete.targetMessageId, 127);
});

test('groups thought move commands by reply target and explicit message id', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 421,
      message: {
        message_id: 711,
        date: 1_746_748_800,
        chat: { id: 42 },
        text: '/移动 杂七杂八',
        reply_to_message: {
          message_id: 126,
        },
      },
    },
    {
      update_id: 422,
      message: {
        message_id: 712,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/移动 127 锻炼',
      },
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].kind, 'thought_move');
  assert.equal(batches[0].thoughtMove.targetMessageId, 126);
  assert.equal(batches[0].thoughtMove.thoughtModule, 'misc');
  assert.equal(batches[1].kind, 'thought_move');
  assert.equal(batches[1].thoughtMove.targetMessageId, 127);
  assert.equal(batches[1].thoughtMove.thoughtModule, 'workout');
});

test('groups legacy /随想 id module messages as thought move commands', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 424,
      message: {
        message_id: 714,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/随想 175 杂七杂八',
      },
    },
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'thought_move');
  assert.equal(batches[0].thoughtMove.command, '/随想');
  assert.equal(batches[0].thoughtMove.targetMessageId, 175);
  assert.equal(batches[0].thoughtMove.thoughtModule, 'misc');
});

test('skips thought move commands without a target module', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.groupTelegramUpdates, 'groupTelegramUpdates export missing');

  const batches = lib.groupTelegramUpdates([
    {
      update_id: 423,
      message: {
        message_id: 713,
        date: 1_746_748_900,
        chat: { id: 42 },
        text: '/移动 127',
      },
    },
  ]);

  assert.equal(batches.length, 0);
});

test('analyzes /analysis batches into ready analysis entries', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const analyzed = lib.analyzeTelegramBatch({
    kind: 'analysis',
    batchId: 'analysis-21',
    messages: [
      {
        updateId: 301,
        messageId: 21,
        mediaGroupId: null,
        caption: '',
        text: '/analysis 今天怎么练',
        chatId: 42,
        dateUnix: 1_746_748_800,
        photos: [],
      },
    ],
    analysis: {
      command: '/analysis',
      question: '今天怎么练',
    },
  }, []);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.kind, 'analysis');
  assert.equal(analyzed.analysis.command, '/analysis');
  assert.equal(analyzed.analysis.question, '今天怎么练');
  assert.equal(analyzed.analysis.telegramMessageId, 21);
  assert.equal(analyzed.analysis.telegramChatId, 42);
});

test('analyzes /thought batches into ready thought entries', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    kind: 'thought',
    batchId: 'thought-11',
    messages: [
      {
        updateId: 201,
        messageId: 11,
        mediaGroupId: null,
        caption: '',
        text: '/thought 今天训练后臀部发力更明显\n感觉动作路线更顺了',
        chatId: 42,
        dateUnix: 1_746_748_800,
        photos: [],
      },
    ],
    thought: {
      command: '/thought',
      body: '今天训练后臀部发力更明显\n感觉动作路线更顺了',
    },
  };

  const analyzed = lib.analyzeTelegramBatch(batch, []);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.kind, 'thought');
  assert.equal(analyzed.thought.body, '今天训练后臀部发力更明显\n感觉动作路线更顺了');
});

test('skips /thought batches when the command body is empty', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    kind: 'thought',
    batchId: 'thought-15',
    messages: [
      {
        updateId: 205,
        messageId: 15,
        mediaGroupId: null,
        caption: '',
        text: '/thought ',
        chatId: 42,
        dateUnix: 1_746_748_800,
        photos: [],
      },
    ],
    thought: {
      command: '/thought',
      body: '',
    },
  };

  const analyzed = lib.analyzeTelegramBatch(batch, []);

  assert.equal(analyzed.status, 'skipped');
  assert.equal(analyzed.kind, 'thought');
  assert.match(analyzed.reason, /empty thought body/);
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
      imageType: 'workout',
      detectedDate: '2026-05-08',
      dateEvidence: 'ocr',
      confidence: 0.92,
      warnings: [],
      records: {
        activities: [
          {
            time: '07:10',
            type: '自由训练',
            detail: '总消耗180千卡，时长00:20:04，平均心率132次/分钟',
          },
        ],
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
        detectedDate: message.messageId === 32 ? '2026-05-09' : null,
        dateEvidence: message.messageId === 32 ? 'image header' : 'no visible image date',
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

test('normalizes detected month-day using the telegram message year when AI returns an impossible year', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-13',
    messages: [
      {
        updateId: 520905341,
        messageId: 13,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 9, 8, 56, 29) / 1000,
        photos: [{ fileId: 'file-workout', fileUniqueId: 'uniq-workout' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 13,
      imageType: 'workout',
      detectedDate: '5669-05-06',
      dateEvidence: 'image only shows month-day',
      confidence: 0.95,
      warnings: ['year is unreliable'],
      records: {
        activities: [
          {
            time: '20:27',
            type: '力量训练',
            detail: '总消耗250千卡，时长00:28:48，平均心率125次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-06');
});

test('uses the explicit year from the screenshot when a valid four-digit year is present', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-explicit-year',
    messages: [
      {
        updateId: 520905341,
        messageId: 131,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 8, 56, 29) / 1000,
        photos: [{ fileId: 'file-workout', fileUniqueId: 'uniq-workout' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 131,
      imageType: 'workout',
      detectedDate: '2025-05-13',
      dateEvidence: 'image header shows 2025年5月13日',
      confidence: 0.95,
      warnings: [],
      records: {
        activities: [
          {
            time: '20:27',
            type: '力量训练',
            detail: '总消耗250千卡，时长00:28:48，平均心率125次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2025-05-13');
});

test('falls back to the telegram message year when OCR returns an invalid full date but the image only shows month-day', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-invalid-full-date',
    messages: [
      {
        updateId: 520905341,
        messageId: 132,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 8, 56, 29) / 1000,
        photos: [{ fileId: 'file-workout', fileUniqueId: 'uniq-workout' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 132,
      imageType: 'workout',
      detectedDate: '2026-13-13',
      dateEvidence: 'activity rows show 5月13日',
      confidence: 0.95,
      warnings: [],
      records: {
        activities: [
          {
            time: '20:27',
            type: '力量训练',
            detail: '总消耗250千卡，时长00:28:48，平均心率125次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-13');
});

test('rejects impossible full dates instead of treating them as reliable archive dates', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-impossible-full-date',
    messages: [
      {
        updateId: 520905341,
        messageId: 133,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 8, 56, 29) / 1000,
        photos: [{ fileId: 'file-workout', fileUniqueId: 'uniq-workout' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 133,
      imageType: 'workout',
      detectedDate: '2026-02-31',
      dateEvidence: 'ocr guessed 2026-02-31',
      confidence: 0.95,
      warnings: [],
      records: {
        activities: [
          {
            time: '20:27',
            type: '力量训练',
            detail: '总消耗250千卡，时长00:28:48，平均心率125次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.match(analyzed.reason, /no reliable image or filename date/i);
});

test('fills missing measurement date from telegram message year when month-day is visible in evidence', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-14',
    messages: [
      {
        updateId: 520905342,
        messageId: 14,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 9, 8, 56, 29) / 1000,
        photos: [{ fileId: 'file-measurement', fileUniqueId: 'uniq-measurement' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 14,
      imageType: 'measurement',
      detectedDate: null,
      dateEvidence: 'image shows 5月6日 but no year',
      confidence: 0.97,
      warnings: [],
      records: {
        measurement: {
          measuredAt: null,
          bodyScore: 77,
          weightKg: 73.55,
          bmi: 23.7,
          bodyFatPct: 22.4,
          skeletalMuscleKg: 30.9,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1609,
          bodyWaterPct: 50.5,
          proteinPct: 23,
          boneMassKg: 2.98,
          fatFreeMassKg: 57.1,
          bodyAge: 31,
          bodyType: '标准型',
        },
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-06');
  assert.equal(analyzed.measurement?.measuredAt, '2026-05-06');
});

test('uses measurement measuredAt as fallback archived date for a multi-image album', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-measured-at-fallback',
    messages: [
      {
        updateId: 520905409,
        messageId: 91,
        mediaGroupId: 'album-measured-at-fallback',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-nutrition', fileUniqueId: 'uniq-nutrition' }],
      },
      {
        updateId: 520905410,
        messageId: 92,
        mediaGroupId: 'album-measured-at-fallback',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-measurement', fileUniqueId: 'uniq-measurement' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 91,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.95,
      warnings: [],
      records: {
        measurement: null,
        activities: [],
        meals: [
          { name: '早餐', calories: 108, recommendedMin: 515, recommendedMax: 927 },
          { name: '午餐', calories: 396, recommendedMin: 618, recommendedMax: 1030 },
          { name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 },
        ],
        totalCalories: 969,
        details: ['早餐 108 千卡', '午餐 396 千卡', '晚餐 465 千卡'],
        dailyWorkoutSummary: null,
      },
    },
    {
      messageId: 92,
      imageType: 'measurement',
      detectedDate: null,
      dateEvidence: 'body scale screenshot does not need extra OCR date evidence',
      confidence: 0.98,
      warnings: [],
      records: {
        measurement: {
          measuredAt: '2026-05-14 06:23',
          bodyScore: 73,
          weightKg: 73.65,
          bmi: 23.7,
          bodyFatPct: 24.1,
          skeletalMuscleKg: 30.7,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1601,
          bodyWaterPct: 48.6,
          proteinPct: 23.3,
          boneMassKg: 2.965,
          fatFreeMassKg: 55.9,
          bodyAge: 32,
          bodyType: '肥胖型',
        },
        activities: [],
        meals: [],
        totalCalories: null,
        details: [],
        dailyWorkoutSummary: null,
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-14');
  assert.equal(analyzed.measurement?.measuredAt, '2026-05-14 06:23');
  assert.equal(analyzed.nutrition.totalCalories, 969);
});

test('skips a multi-image album when every image lacks a reliable date', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-no-date',
    messages: [
      {
        updateId: 601,
        messageId: 61,
        mediaGroupId: 'album-no-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-a', fileUniqueId: 'uniq-a' }],
      },
      {
        updateId: 602,
        messageId: 62,
        mediaGroupId: 'album-no-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-b', fileUniqueId: 'uniq-b' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 61,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.94,
      warnings: [],
      records: {
        measurement: null,
        activities: [],
        meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
        totalCalories: 465,
        details: ['晚餐 465 千卡'],
        dailyWorkoutSummary: null,
      },
    },
    {
      messageId: 62,
      imageType: 'measurement',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.95,
      warnings: [],
      records: {
        measurement: {
          measuredAt: null,
          bodyScore: 73,
          weightKg: 73.65,
          bmi: 23.7,
          bodyFatPct: 24.1,
          skeletalMuscleKg: 30.7,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1601,
          bodyWaterPct: 48.6,
          proteinPct: 23.3,
          boneMassKg: 2.965,
          fatFreeMassKg: 55.9,
          bodyAge: 32,
          bodyType: '肥胖型',
        },
        activities: [],
        meals: [],
        totalCalories: null,
        details: [],
        dailyWorkoutSummary: null,
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.equal(analyzed.batchId, 'album-no-date');
  assert.match(analyzed.reason, /no reliable image or filename date/i);
});

test('skips a multi-image album when reliable detected dates conflict', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-conflicting-dates',
    messages: [
      {
        updateId: 701,
        messageId: 71,
        mediaGroupId: 'album-conflicting-dates',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-a', fileUniqueId: 'uniq-a' }],
      },
      {
        updateId: 702,
        messageId: 72,
        mediaGroupId: 'album-conflicting-dates',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 0, 23, 0) / 1000,
        photos: [{ fileId: 'file-b', fileUniqueId: 'uniq-b' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 71,
      imageType: 'nutrition',
      detectedDate: '2026-05-14',
      dateEvidence: 'ocr',
      confidence: 0.94,
      warnings: [],
      records: {
        measurement: null,
        activities: [],
        meals: [{ name: '早餐', calories: 108, recommendedMin: 515, recommendedMax: 927 }],
        totalCalories: 108,
        details: ['早餐 108 千卡'],
        dailyWorkoutSummary: null,
      },
    },
    {
      messageId: 72,
      imageType: 'measurement',
      detectedDate: '2026-05-13',
      dateEvidence: 'ocr',
      confidence: 0.95,
      warnings: [],
      records: {
        measurement: {
          measuredAt: '2026-05-13 06:23',
          bodyScore: 73,
          weightKg: 73.65,
          bmi: 23.7,
          bodyFatPct: 24.1,
          skeletalMuscleKg: 30.7,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1601,
          bodyWaterPct: 48.6,
          proteinPct: 23.3,
          boneMassKg: 2.965,
          fatFreeMassKg: 55.9,
          bodyAge: 32,
          bodyType: '肥胖型',
        },
        activities: [],
        meals: [],
        totalCalories: null,
        details: [],
        dailyWorkoutSummary: null,
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.equal(analyzed.batchId, 'album-conflicting-dates');
  assert.match(analyzed.reason, /conflicting detected dates/i);
  assert.match(analyzed.reason, /2026-05-13/);
  assert.match(analyzed.reason, /2026-05-14/);
});

test('merges into existing 2026-05-06 blocks without duplicating headings or null timestamps', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const markdown = `
### 2026-05-06

#### 2026-05-06 饮食截图记录
<!-- telegram-sync-section -->
##### 餐次汇总

<!-- telegram-fingerprint: n-2026-05-06-凉粉（早餐，1碗）-114 -->
- 凉粉（早餐，1碗）：114千卡，建议范围527–949千卡
<!-- telegram-fingerprint: n-2026-05-06-扯面（午餐，400克）-452 -->
- 扯面（午餐，400克）：452千卡，建议范围633–1054千卡
<!-- telegram-fingerprint: n-2026-05-06-兰州拉面（晚餐，1碗）-510 -->
- 兰州拉面（晚餐，1碗）：510千卡，建议范围317–738千卡
- 当日截图内已记录总热量：1076千卡

##### 餐次明细

- 早餐 114千卡
- 午餐 452千卡
- 晚餐 510千卡

#### 当日运动截图记录
<!-- telegram-sync-section -->
<!-- telegram-fingerprint: a-2026-05-06-07:15-自由训练-565 -->
- 07:15 自由训练：总消耗565千卡，时长00:53:22，平均心率141次/分钟

### 2026-05-07

- 占位
`;

  const batchResult = {
    batchId: 'album-56',
    archivedDate: '2026-05-06',
    measurement: {
      measuredAt: '2026-05-06',
      bodyScore: 77,
      weightKg: 73.55,
      bmi: 23.7,
      bodyFatPct: 22.4,
      skeletalMuscleKg: 30.9,
      visceralFatLevel: 9,
      basalMetabolismKcal: 1609,
      bodyWaterPct: 50.5,
      proteinPct: 23,
      boneMassKg: 2.985,
      fatFreeMassKg: 57.1,
      bodyAge: 31,
      bodyType: '标准型',
    },
    activities: [
      {
        time: '5月6日 07:15',
        type: '自由训练',
        detail: '总消耗 565 千卡，时长 00:53:22，平均心率 141 次/分钟',
      },
      {
        time: '5月6日 20:04',
        type: '自由训练',
        detail: '总消耗 162 千卡，时长 00:19:43，平均心率 124 次/分钟',
      },
      {
        time: '5月6日 20:27',
        type: '力量训练',
        detail: '总消耗 250 千卡，时长 00:28:48，平均心率 125 次/分钟',
      },
    ],
    nutrition: {
      meals: [
        { name: '凉粉', calories: 114, recommendedMin: 527, recommendedMax: 949 },
        { name: '扯面', calories: 452, recommendedMin: 633, recommendedMax: 1054 },
        { name: '兰州拉面', calories: 510, recommendedMin: 317, recommendedMax: 738 },
      ],
      totalCalories: 1076,
      details: [
        '早餐 114 千卡，建议范围 527-949 千卡',
        '午餐 452 千卡，建议范围 633-1054 千卡',
        '晚餐 510 千卡，建议范围 317-738 千卡',
      ],
    },
    fingerprints: {
      measurement: ['m-2026-05-06-2026-05-06-73.55-22.4'],
      activities: [
        'a-2026-05-06-07:15-自由训练-565',
        'a-2026-05-06-20:04-自由训练-162',
        'a-2026-05-06-20:27-力量训练-250',
      ],
      nutrition: [
        'n-2026-05-06-凉粉-114',
        'n-2026-05-06-扯面-452',
        'n-2026-05-06-兰州拉面-510',
      ],
    },
  };

  const result = lib.applyTelegramSyncToMarkdown(markdown, batchResult);

  assert.equal((result.markdown.match(/##### 餐次汇总/g) ?? []).length, 1);
  assert.equal((result.markdown.match(/5月6日 20:27/g) ?? []).length, 0);
  assert.equal((result.markdown.match(/- 20:27 力量训练：/g) ?? []).length, 1);
  assert.equal(result.markdown.includes('测量时间：null'), false);
  assert.equal(result.markdown.includes('测量时间：2026-05-06'), true);
});

test('skips an album when workout and next-morning measurement dates conflict', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-shared-date',
    messages: [
      {
        updateId: 401,
        messageId: 41,
        mediaGroupId: 'album-shared-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'w-1', fileUniqueId: 'wu-1' }],
      },
      {
        updateId: 402,
        messageId: 42,
        mediaGroupId: 'album-shared-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'n-1', fileUniqueId: 'nu-1' }],
      },
      {
        updateId: 403,
        messageId: 43,
        mediaGroupId: 'album-shared-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'm-1', fileUniqueId: 'mu-1' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 41,
      imageType: 'workout',
      detectedDate: '5099-05-09',
      dateEvidence: 'activity rows show 5月9日',
      confidence: 0.96,
      warnings: [],
      records: {
        activities: [
          { time: '19:13', type: '力量训练', detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟' },
        ],
      },
    },
    {
      messageId: 42,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.95,
      warnings: [],
      records: {
        meals: [
          { name: '晚餐-方便面 1块', calories: 473, recommendedMin: 317, recommendedMax: 740 },
          { name: '晚餐-尖椒炒腊肉 1盘', calories: 592, recommendedMin: 317, recommendedMax: 740 },
        ],
        totalCalories: 1593,
        details: ['晚餐 1065 千卡（建议范围 317-740 千卡）'],
      },
    },
    {
      messageId: 43,
      imageType: 'measurement',
      detectedDate: '2026-05-10',
      dateEvidence: 'body scale screenshot top-right shows 2026年5月10日 06:14',
      confidence: 0.98,
      warnings: [],
      records: {
        measurement: {
          measuredAt: '06:14',
          bodyScore: 74,
          weightKg: 73.45,
          bmi: 23.7,
          bodyFatPct: 22.9,
          skeletalMuscleKg: 30.6,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1596,
          bodyWaterPct: 49.7,
          proteinPct: 23.3,
          boneMassKg: 2.955,
          fatFreeMassKg: 56.6,
          bodyAge: 32,
          bodyType: '肥胖型',
        },
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.equal(analyzed.batchId, 'album-shared-date');
  assert.match(analyzed.reason, /conflicting detected dates/i);
  assert.match(analyzed.reason, /2026-05-09/);
  assert.match(analyzed.reason, /2026-05-10/);
});

test('applies the only dated screenshot date to undated images in the same album', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-one-date',
    messages: [
      {
        updateId: 501,
        messageId: 51,
        mediaGroupId: 'album-one-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'dated-workout', fileUniqueId: 'dated-workout-u' }],
      },
      {
        updateId: 502,
        messageId: 52,
        mediaGroupId: 'album-one-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'undated-nutrition', fileUniqueId: 'undated-nutrition-u' }],
      },
      {
        updateId: 503,
        messageId: 53,
        mediaGroupId: 'album-one-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 10, 2, 0, 0) / 1000,
        photos: [{ fileId: 'undated-measurement', fileUniqueId: 'undated-measurement-u' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 51,
      imageType: 'workout',
      detectedDate: '2026-05-09',
      dateEvidence: 'workout list shows 2026-05-09',
      confidence: 0.96,
      warnings: [],
      records: {
        activities: [
          { time: '19:13', type: '力量训练', detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟' },
        ],
      },
    },
    {
      messageId: 52,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.95,
      warnings: [],
      records: {
        meals: [
          { name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 },
        ],
        totalCalories: 1593,
        details: ['晚餐 1065 千卡'],
      },
    },
    {
      messageId: 53,
      imageType: 'measurement',
      detectedDate: null,
      dateEvidence: 'no visible date',
      confidence: 0.95,
      warnings: [],
      records: {
        measurement: {
          measuredAt: null,
          bodyScore: 74,
          weightKg: 73.45,
          bmi: 23.7,
          bodyFatPct: 22.9,
          skeletalMuscleKg: 30.6,
          visceralFatLevel: 9,
          basalMetabolismKcal: 1596,
          bodyWaterPct: 49.7,
          proteinPct: 23.3,
          boneMassKg: 2.955,
          fatFreeMassKg: 56.6,
          bodyAge: 32,
          bodyType: '肥胖型',
        },
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-09');
  assert.equal(analyzed.measurement?.measuredAt, '2026-05-09');
  assert.equal(analyzed.activities.length, 1);
  assert.equal(analyzed.nutrition.totalCalories, 1593);
});

test('uses a filename date from any position when screenshots are undated', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-filename-date',
    messages: [
      {
        updateId: 801,
        messageId: 81,
        mediaGroupId: 'album-filename-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [
          {
            fileId: 'file-nutrition',
            fileUniqueId: 'uniq-nutrition',
            fileName: '饮食记录 2026-05-12.jpg',
            source: 'document',
          },
        ],
      },
      {
        updateId: 802,
        messageId: 82,
        mediaGroupId: 'album-filename-date',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [
          {
            fileId: 'file-workout',
            fileUniqueId: 'uniq-workout',
            fileName: '20260512 运动记录.png',
            source: 'document',
          },
        ],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 81,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no reliable image date',
      confidence: 0.96,
      warnings: [],
      records: {
        meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
        totalCalories: 465,
        details: ['晚餐 465 千卡'],
      },
    },
    {
      messageId: 82,
      imageType: 'workout',
      detectedDate: null,
      dateEvidence: 'no reliable image date',
      confidence: 0.95,
      warnings: [],
      records: {
        activities: [
          {
            time: '19:12',
            type: '力量训练',
            detail: '总消耗189千卡，时长00:20:49，平均心率132次/分钟',
          },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-12');
  assert.match(analyzed.warnings.join('\n'), /filename date 2026-05-12/i);
});

test('accepts a visible gallery filename date from image evidence when Telegram photo has no filename', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-visible-gallery-filename-date',
    messages: [
      {
        updateId: 806,
        messageId: 806,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 14, 12, 0, 0) / 1000,
        photos: [
          {
            fileId: 'file-nutrition',
            fileUniqueId: 'uniq-nutrition',
            fileName: null,
            source: 'photo',
          },
        ],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 806,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'image file info panel shows filename 2026-4-03饮食记录.jpg',
      confidence: 0.96,
      warnings: [],
      records: {
        meals: [{ name: '早餐', calories: 510, recommendedMin: 307, recommendedMax: 712 }],
        totalCalories: 510,
        details: ['早餐 510 千卡'],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-04-03');
});

test('uses filename month-day with telegram message year when screenshots are undated', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-filename-month-day',
    messages: [
      {
        updateId: 811,
        messageId: 811,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [
          {
            fileId: 'file-nutrition',
            fileUniqueId: 'uniq-nutrition',
            fileName: '饮食记录 5月12日.jpg',
            source: 'document',
          },
        ],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 811,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no reliable image date',
      confidence: 0.96,
      warnings: [],
      records: {
        meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
        totalCalories: 465,
        details: ['晚餐 465 千卡'],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-12');
});

test('skips undated screenshots when filename dates conflict', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'album-conflicting-filename-dates',
    messages: [
      {
        updateId: 821,
        messageId: 821,
        mediaGroupId: 'album-conflicting-filename-dates',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [{ fileId: 'file-a', fileUniqueId: 'uniq-a', fileName: '饮食 2026-05-12.jpg' }],
      },
      {
        updateId: 822,
        messageId: 822,
        mediaGroupId: 'album-conflicting-filename-dates',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [{ fileId: 'file-b', fileUniqueId: 'uniq-b', fileName: '运动 2026-05-13.jpg' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 821,
      imageType: 'nutrition',
      detectedDate: null,
      dateEvidence: 'no reliable image date',
      confidence: 0.96,
      warnings: [],
      records: {
        meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
        totalCalories: 465,
        details: ['晚餐 465 千卡'],
      },
    },
    {
      messageId: 822,
      imageType: 'workout',
      detectedDate: null,
      dateEvidence: 'no reliable image date',
      confidence: 0.95,
      warnings: [],
      records: {
        activities: [
          { time: '19:12', type: '力量训练', detail: '总消耗189千卡，时长00:20:49' },
        ],
      },
    },
  ]);

  assert.equal(analyzed.status, 'skipped');
  assert.match(analyzed.reason, /conflicting filename dates/i);
  assert.match(analyzed.reason, /2026-05-12/);
  assert.match(analyzed.reason, /2026-05-13/);
});

test('uses image date over conflicting filename date and records a warning', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');

  const batch = {
    batchId: 'single-image-over-filename-date',
    messages: [
      {
        updateId: 831,
        messageId: 831,
        mediaGroupId: null,
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 13, 1, 0, 0) / 1000,
        photos: [{ fileId: 'file-a', fileUniqueId: 'uniq-a', fileName: '饮食 2026-05-13.jpg' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 831,
      imageType: 'nutrition',
      detectedDate: '2026-05-12',
      dateEvidence: 'image header shows 2026-05-12',
      confidence: 0.96,
      warnings: [],
      records: {
        meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
        totalCalories: 465,
        details: ['晚餐 465 千卡'],
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.equal(analyzed.archivedDate, '2026-05-12');
  assert.match(analyzed.warnings.join('\n'), /filename date\(s\) 2026-05-13 differ/i);
});

test('merges same-day workout updates without dropping prior activity or nutrition blocks', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const markdown = `
### 2026-05-09

#### 当日运动截图记录
<!-- telegram-sync-section -->
<!-- telegram-fingerprint: a-2026-05-09-06:45-自由训练-180 -->
- 06:45 自由训练：总消耗180千卡，时长00:20:04，平均心率132次/分钟

#### 2026-05-09 饮食截图记录
<!-- telegram-sync-section -->
##### 餐次汇总

<!-- telegram-fingerprint: n-2026-05-09-晚餐-1065 -->
- 晚餐：1065千卡，建议范围317–740千卡
- 当日截图内已记录总热量：1593千卡

##### 餐次明细

- 旧晚餐 1065 千卡
`;

  const batchResult = {
    batchId: 'album-reupload',
    archivedDate: '2026-05-09',
    measurement: null,
    activities: [
      {
        time: '19:13',
        type: '力量训练',
        detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
      },
    ],
    nutrition: {
      meals: [],
      totalCalories: null,
      details: [],
    },
    fingerprints: {
      measurement: [],
      activities: ['a-2026-05-09-19:13-力量训练-241'],
      nutrition: [],
    },
  };

  const result = lib.applyTelegramSyncToMarkdown(markdown, batchResult);

  assert.equal(result.changed, true);
  assert.equal(result.markdown.includes('06:45 燃脂训练'), true);
  assert.equal(result.markdown.includes('旧晚餐'), true);
  assert.equal(result.markdown.includes('19:13 力量训练'), true);
  assert.equal(result.markdown.includes('当日截图内已记录总热量：1593千卡'), true);
  assert.equal((result.markdown.match(/##### 活动明细/g) ?? []).length, 1);
});

test('merges same-day overview and measurement without dropping activity details or nutrition', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const markdown = `
### 2026-05-22

#### 当日运动截图记录

<!-- telegram-sync-section -->

##### 活动明细

<!-- telegram-fingerprint: a-2026-05-22-06:40-HIIT-375 -->
- 06:40 HIIT：总消耗375千卡，时长00:40:01，平均心率145次/分钟
<!-- telegram-fingerprint: a-2026-05-22-08:20-户外骑行-na -->
- 08:20 户外骑行：距离3.14公里，时长00:12:41，均速14.85公里/小时

#### 2026-05-22 饮食截图记录
<!-- telegram-sync-section -->
##### 餐次汇总

<!-- telegram-fingerprint: n-2026-05-22-早餐-597 -->
- 早餐：597千卡，建议范围512–922千卡
<!-- telegram-fingerprint: n-2026-05-22-午餐-788 -->
- 午餐：788千卡，建议范围615–1024千卡
- 当日截图内已记录总热量：1385千卡
`;

  const batchResult = {
    batchId: 'album-overview-measurement',
    archivedDate: '2026-05-22',
    measurement: {
      measuredAt: '2026-05-22',
      weightKg: 73.7,
      bmi: 23.7,
      bodyFatPct: 22.8,
      skeletalMuscleKg: 30.8,
      visceralFatLevel: 9,
      basalMetabolismKcal: 1605,
    },
    workoutDailySummary: {
      activityCaloriesKcal: 1077,
      workoutDurationMinutes: 148,
      activeHours: 14,
    },
    activities: [],
    nutrition: {
      meals: [],
      totalCalories: null,
      details: [],
    },
    fingerprints: {
      measurement: ['m-2026-05-22-2026-05-22-73.7-22.8'],
      workoutDailySummary: ['ws-2026-05-22-1077-148-14'],
      activities: [],
      nutrition: [],
    },
  };

  const result = lib.applyTelegramSyncToMarkdown(markdown, batchResult);
  const parsed = parseTrainingRecord(result.markdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-22');

  assert.equal(result.changed, true);
  assert.equal(result.markdown.includes('活动热量：1077千卡'), true);
  assert.equal(result.markdown.includes('06:40 HIIT'), true);
  assert.equal(result.markdown.includes('早餐：597千卡'), true);
  assert.equal(result.markdown.includes('体重：73.7 kg'), true);
  assert.equal(day.activities.length, 2);
  assert.equal(day.nutrition.totalCalories, 1385);
  assert.equal(day.measurement.weightKg, 73.7);
  assert.equal(day.workoutSummary.workoutDurationMinutes, 148);
});

test('merges legacy same-day screenshot blocks without duplicating headings', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const markdown = `
### 2026-05-13

#### 当日运动截图记录

##### 当日活动总览

- 活动热量：703千卡
- 锻炼时长：97分钟

##### 活动明细

- 08:04 户外骑行：3.18公里，14.93公里/小时
- 11:35 outdoor_cycling：3.04公里，10.95公里/小时

#### 2026-05-13 饮食截图记录

##### 餐次汇总

- 早餐：100千卡，建议范围515–927千卡
- 当日截图内已记录总热量：100千卡
`;

  const batchResult = {
    batchId: 'album-replace-legacy',
    archivedDate: '2026-05-13',
    measurement: null,
    workoutDailySummary: {
      activityCaloriesKcal: 703,
      workoutDurationMinutes: 97,
      activeHours: 21,
    },
    activities: [
      {
        time: '08:04',
        type: '户外骑行',
        detail: '3.18公里，时长00:12:47，平均速度14.93公里/小时',
      },
      {
        time: '08:17',
        type: '爬楼',
        detail: '总消耗83千卡，时长00:09:07，平均心率134次/分钟',
      },
    ],
    nutrition: {
      meals: [
        { name: '早餐', calories: 108, recommendedMin: 515, recommendedMax: 927 },
        { name: '午餐', calories: 396, recommendedMin: 618, recommendedMax: 1030 },
        { name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 },
      ],
      totalCalories: 969,
      details: [],
    },
    fingerprints: {
      measurement: [],
      workoutDailySummary: ['ws-2026-05-13-703-97-21'],
      activities: [
        'a-2026-05-13-08:04-户外骑行-na',
        'a-2026-05-13-08:17-爬楼-83',
      ],
      nutrition: [
        'n-2026-05-13-早餐-108',
        'n-2026-05-13-午餐-396',
        'n-2026-05-13-晚餐-465',
      ],
    },
  };

  const result = lib.applyTelegramSyncToMarkdown(markdown, batchResult);
  const parsed = parseTrainingRecord(result.markdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-13');

  assert.equal(result.changed, true);
  assert.equal(result.markdown.includes('11:35 户外骑行'), true);
  assert.equal((result.markdown.match(/08:04 户外骑行/g) ?? []).length, 1);
  assert.equal(day.activities.length, 3);
  assert.deepEqual(day.workoutSummary.countsByType, {
    户外骑行: 2,
    爬楼: 1,
  });
  assert.equal(day.workoutSummary.activeHours, 21);
  assert.equal(day.nutrition.totalCalories, 969);
  assert.equal(day.nutrition.meals.length, 3);
});

test('merges a daily activity overview screenshot into the same workout block', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.analyzeTelegramBatch, 'analyzeTelegramBatch export missing');
  assert.ok(lib?.applyTelegramSyncToMarkdown, 'applyTelegramSyncToMarkdown export missing');

  const batch = {
    batchId: 'album-activity-overview',
    messages: [
      {
        updateId: 601,
        messageId: 61,
        mediaGroupId: 'album-activity-overview',
        caption: '归档到 2026-05-10',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 11, 7, 50, 0) / 1000,
        photos: [{ fileId: 'overview-file', fileUniqueId: 'overview-uniq' }],
      },
      {
        updateId: 602,
        messageId: 62,
        mediaGroupId: 'album-activity-overview',
        caption: '',
        text: '',
        chatId: 42,
        dateUnix: Date.UTC(2026, 4, 11, 7, 50, 0) / 1000,
        photos: [{ fileId: 'workout-file', fileUniqueId: 'workout-uniq' }],
      },
    ],
  };

  const analyzed = lib.analyzeTelegramBatch(batch, [
    {
      messageId: 61,
      imageType: 'workout',
      detectedDate: '2026-05-10',
      dateEvidence: 'activity overview shows 2026年5月10日',
      confidence: 0.98,
      warnings: [],
      records: {
        activities: [],
        meals: [],
        totalCalories: null,
        details: [],
        measurement: null,
        dailyWorkoutSummary: {
          activityCaloriesKcal: 643,
          workoutDurationMinutes: 78,
          activeHours: 12,
        },
      },
    },
    {
      messageId: 62,
      imageType: 'workout',
      detectedDate: '2026-05-10',
      dateEvidence: 'activity rows show 5月10日',
      confidence: 0.96,
      warnings: [],
      records: {
        activities: [
          {
            time: '08:15',
            type: '户外骑行',
            detail: '1.65公里，时长00:23:58，平均速度4.13公里/小时',
          },
          {
            time: '08:49',
            type: '户外骑行',
            detail: '8.49公里，时长00:36:04，平均速度14.12公里/小时',
          },
        ],
        meals: [],
        totalCalories: null,
        details: [],
        measurement: null,
        dailyWorkoutSummary: null,
      },
    },
  ]);

  assert.equal(analyzed.status, 'ready');
  assert.deepEqual(analyzed.workoutDailySummary, {
    activityCaloriesKcal: 643,
    workoutDurationMinutes: 78,
    activeHours: 12,
  });

  const markdown = `
### 2026-05-10

- 占位
`;

  const applied = lib.applyTelegramSyncToMarkdown(markdown, analyzed);

  assert.equal(applied.changed, true);
  assert.match(applied.markdown, /##### 当日活动总览/);
  assert.match(applied.markdown, /活动热量：643千卡/);
  assert.match(applied.markdown, /锻炼时长：78分钟/);
  assert.match(applied.markdown, /活动小时数：12小时/);
  assert.match(applied.markdown, /##### 活动明细/);
  assert.match(applied.markdown, /08:49 户外骑行：8.49公里/);
});

test('runs async work with a bounded concurrency limit while preserving result order', async () => {
  const lib = await importTelegramSyncLib();

  assert.ok(lib?.mapWithConcurrency, 'mapWithConcurrency export missing');

  let active = 0;
  let maxActive = 0;
  const result = await lib.mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [10, 20, 30, 40, 50]);
  assert.equal(maxActive, 2);
});
