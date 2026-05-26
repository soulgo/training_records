import test from 'node:test';
import assert from 'node:assert/strict';

import { runTelegramAiAgent } from '../tools/telegram-ai-agent.mjs';

test('telegram ai agent searches records for history search questions', async () => {
  const toolCalls = [];

  const reply = await runTelegramAiAgent({
    question: '搜一下右肩疼痛相关记录',
    env: {},
    callMcpTool: async (name, args) => {
      toolCalls.push({ name, args });
      return {
        success: true,
        data: {
          matches: [
            {
              source: 'thought',
              date: '2026-05-17',
              text: '右肩训练后有刺痛',
            },
          ],
        },
      };
    },
    generateAgentReply: async ({ question, toolResults }) => {
      assert.equal(question, '搜一下右肩疼痛相关记录');
      assert.equal(toolResults.length, 1);
      return '找到 1 条相关记录：右肩训练后有刺痛。';
    },
  });

  assert.equal(reply, '找到 1 条相关记录：右肩训练后有刺痛。');
  assert.deepEqual(toolCalls, [
    {
      name: 'training.search_records',
      args: {
        query: '右肩疼痛',
        types: ['snapshot', 'markdown', 'thought'],
        limit: 5,
      },
    },
  ]);
});

test('telegram ai agent checks runtime status for sync health questions', async () => {
  const toolCalls = [];

  const reply = await runTelegramAiAgent({
    question: '同步状态正常吗',
    env: {},
    callMcpTool: async (name, args) => {
      toolCalls.push({ name, args });
      return {
        success: true,
        data: name === 'runtime.get_sync_status'
          ? { pendingCount: 0, archiveFailureCount: 0 }
          : { config: { TRAINING_SNAPSHOT_SOURCE: 'database' } },
      };
    },
    generateAgentReply: async ({ toolResults }) => {
      assert.equal(toolResults.length, 2);
      return '同步状态正常：暂无 pending 和归档失败。';
    },
  });

  assert.equal(reply, '同步状态正常：暂无 pending 和归档失败。');
  assert.deepEqual(toolCalls, [
    {
      name: 'runtime.get_sync_status',
      args: {
        include_recent_errors: true,
        limit: 3,
      },
    },
    {
      name: 'training.get_config',
      args: {
        keys: ['TRAINING_SNAPSHOT_SOURCE', 'TRAINING_DB_ENABLED', 'MCP_ALLOWED_TOOLS'],
      },
    },
  ]);
});

