import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  callMcpTool,
  listMcpTools,
  resolveMcpConfig,
} from '../src/mcp/tools.mjs';

const sampleMarkdown = `
# 训练记录

### 2026-05-09

#### 当日体脂秤截图记录

- 测量时间：2026-05-09 06:42
- 身体得分：74分
- 体重：72.85 kg
- BMI：23.5
- 体脂率：22.8%
- 骨骼肌量：30.45 kg
- 内脏脂肪等级：8
- 基础代谢率：1587 kcal/日

#### 当日运动截图记录

##### 当日活动总览

- 活动热量：643千卡
- 锻炼时长：78分钟
- 活动小时数：12小时

##### 活动明细

- 08:15 户外骑行：1.65公里，时长00:23:58，平均速度4.13公里/小时
- 19:13 力量训练：总消耗241千卡，时长00:27:50，平均心率129次/分钟

#### 2026-05-09 饮食截图记录

##### 餐次汇总

- 晚餐：1065千卡，建议范围317–740千卡
- 当日截图内已记录总热量：1593千卡

### 2026-05-10

#### 当日运动截图记录

##### 活动明细

- 20:00 燃脂训练：总消耗200千卡，时长00:30:00，平均心率120次/分钟
`;

test('listMcpTools exposes the read-only v1 tool catalog', () => {
  const names = listMcpTools().map((tool) => tool.name);

  assert.ok(names.includes('training.get_snapshot'));
  assert.ok(names.includes('training.get_daily_records'));
  assert.ok(names.includes('training.get_analysis_summary'));
  assert.ok(names.includes('training.get_config'));
  assert.ok(names.includes('runtime.get_sync_status'));
  assert.ok(names.includes('telegram.get_command_registry'));
  assert.ok(!names.includes('training.trigger_telegram_sync'));
});

test('training.get_snapshot returns a uniform envelope and filters date windows', async () => {
  const rootDir = await createFixture();

  const result = await callMcpTool('training.get_snapshot', {
    trace_id: 'trace-fixed',
    source: 'markdown',
    date_from: '2026-05-10',
    date_to: '2026-05-10',
  }, {
    rootDir,
    now: new Date('2026-05-26T00:00:00.000Z'),
  });

  assert.equal(result.success, true);
  assert.equal(result.trace_id, 'trace-fixed');
  assert.equal(result.error, null);
  assert.equal(result.meta.source, 'markdown');
  assert.equal(result.data.daily.length, 1);
  assert.equal(result.data.daily[0].date, '2026-05-10');
  assert.equal(result.data.charts.trainingCalories.length, 1);
});

test('training.get_daily_records can project selected record types', async () => {
  const rootDir = await createFixture();

  const result = await callMcpTool('training.get_daily_records', {
    source: 'markdown',
    types: ['activities', 'nutrition'],
  }, {
    rootDir,
    now: new Date('2026-05-26T00:00:00.000Z'),
  });

  assert.equal(result.success, true);
  assert.equal(result.data.days.length, 2);
  assert.deepEqual(Object.keys(result.data.days[0]).sort(), ['activities', 'date', 'nutrition'].sort());
});

test('training.get_measurements and training.get_activities expose structured slices', async () => {
  const rootDir = await createFixture();

  const measurements = await callMcpTool('training.get_measurements', {
    source: 'markdown',
  }, {
    rootDir,
  });
  const activities = await callMcpTool('training.get_activities', {
    source: 'markdown',
    activity_type: '力量',
  }, {
    rootDir,
  });

  assert.equal(measurements.success, true);
  assert.equal(measurements.data.measurements.length, 1);
  assert.equal(measurements.data.measurements[0].weightKg, 72.85);
  assert.equal(activities.success, true);
  assert.equal(activities.data.activities.length, 1);
  assert.equal(activities.data.activities[0].type, '力量训练');
});

test('training.get_config masks secrets and only returns allowlisted keys', async () => {
  const result = await callMcpTool('training.get_config', {
    keys: ['TRAINING_SNAPSHOT_SOURCE', 'AI_API_KEY', 'TRAINING_DB_URL'],
  }, {
    env: {
      TRAINING_SNAPSHOT_SOURCE: 'database',
      AI_API_KEY: 'secret-key',
      TRAINING_DB_URL: 'postgres://user:pass@example/db',
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.data.config.TRAINING_SNAPSHOT_SOURCE, 'database');
  assert.equal(result.data.config.AI_API_KEY, undefined);
  assert.equal(result.data.config.TRAINING_DB_URL, undefined);
});

test('runtime.get_sync_status reads queue counts without exposing payloads by default', async () => {
  const rootDir = await createFixture({
    pendingLines: [
      JSON.stringify({ batch: { batchId: 'batch-1' }, error: 'db down' }),
      'not-json',
    ],
    archiveLines: [
      JSON.stringify({ error: { message: 'archive failed' } }),
    ],
  });

  const result = await callMcpTool('runtime.get_sync_status', {}, { rootDir });

  assert.equal(result.success, true);
  assert.equal(result.data.pendingCount, 1);
  assert.equal(result.data.pendingInvalidLines, 1);
  assert.equal(result.data.archiveFailureCount, 1);
  assert.equal(result.data.pending, undefined);
});

test('training.search_records searches markdown and thought posts', async () => {
  const rootDir = await createFixture();

  const result = await callMcpTool('training.search_records', {
    query: '刺痛',
    source: 'markdown',
  }, {
    rootDir,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.matches.length, 1);
  assert.equal(result.data.matches[0].source, 'thought');
  assert.match(result.data.matches[0].text, /刺痛/);
});

test('telegram.get_command_registry returns declared commands and aliases', async () => {
  const result = await callMcpTool('telegram.get_command_registry');

  assert.equal(result.success, true);
  assert.ok(result.data.commands.some((command) => command.name === 'analysis'));
  assert.ok(result.data.commands.some((command) => command.aliases.includes('/随想')));
});

test('training.generate_analysis returns reply summary and focus without Telegram side effects', async () => {
  const rootDir = await createFixture();
  let fetchCalled = false;

  const result = await callMcpTool('training.generate_analysis', {
    question: '最近7天训练怎么样？',
    source: 'markdown',
  }, {
    rootDir,
    env: {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
    },
    now: new Date('2026-05-26T00:00:00.000Z'),
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '数据结论：最近训练记录可用。',
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(fetchCalled, true);
  assert.equal(result.data.reply, '数据结论：最近训练记录可用。');
  assert.equal(result.data.focus.w, 'recent7');
  assert.equal(result.data.summary.dataSource, 'markdown');
});

test('callMcpTool returns structured validation errors', async () => {
  const result = await callMcpTool('training.get_snapshot', {
    date_from: '2026/05/10',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.data, null);
  assert.ok(result.trace_id.startsWith('mcp_'));
});

test('resolveMcpConfig honors readonly defaults and allowed tool overrides', () => {
  const config = resolveMcpConfig({
    MCP_READONLY: '',
    MCP_ALLOWED_TOOLS: 'training.get_snapshot,training.get_config',
  });

  assert.equal(config.readonly, true);
  assert.deepEqual(config.allowedTools, new Set(['training.get_snapshot', 'training.get_config']));
});

async function createFixture(options = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-tools-'));
  await mkdir(path.join(rootDir, 'source', '_posts'), { recursive: true });
  await mkdir(path.join(rootDir, 'runtime'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');
  await writeFile(
    path.join(rootDir, 'source', '_posts', '2026-05-09-telegram-thought-610.md'),
    [
      '---',
      'date: 2026-05-09 22:15:00',
      'tags:',
      '  - 身体反馈',
      '  - 随想',
      '  - Telegram',
      'thought_module: body_feedback',
      'telegram_message_id: 610',
      'telegram_chat_id: 42',
      '---',
      '',
      '硬拉后右侧腰背有点刺痛',
      '',
    ].join('\n'),
    'utf8',
  );
  if (options.pendingLines) {
    await writeFile(
      path.join(rootDir, 'runtime', 'telegram-sync-pending.ndjson'),
      `${options.pendingLines.join('\n')}\n`,
      'utf8',
    );
  }
  if (options.archiveLines) {
    await writeFile(
      path.join(rootDir, 'runtime', 'training-db-sync.ndjson'),
      `${options.archiveLines.join('\n')}\n`,
      'utf8',
    );
  }
  return rootDir;
}
