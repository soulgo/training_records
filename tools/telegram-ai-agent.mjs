import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider } from '../src/ai/provider.mjs';
import { callMcpTool as defaultCallMcpTool } from '../src/mcp/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultAllowedTools = new Set([
  'training.get_latest_status',
  'training.get_daily_records',
  'training.get_measurements',
  'training.get_activities',
  'training.get_nutrition',
  'training.get_body_feedback',
  'training.get_analysis_summary',
  'training.generate_analysis',
  'training.search_records',
  'training.get_config',
  'runtime.get_sync_status',
  'telegram.get_command_registry',
]);

export async function runTelegramAiAgent(options = {}) {
  const env = options.env ?? process.env;
  const question = normalizeAgentQuestion(options.question);
  const callMcpTool = options.callMcpTool ?? defaultCallMcpTool;
  const allowedTools = parseAllowedTools(env.TELEGRAM_AI_AGENT_ALLOWED_TOOLS);
  const maxToolCalls = parsePositiveInteger(env.TELEGRAM_AI_AGENT_MAX_TOOL_CALLS, 4);
  const plan = buildTelegramAiAgentPlan(question).slice(0, maxToolCalls);
  const toolResults = [];

  for (const step of plan) {
    if (!isToolAllowed(step.name, allowedTools)) {
      toolResults.push({
        name: step.name,
        args: step.args,
        result: {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: `Tool is not allowed for Telegram AI agent: ${step.name}`,
            retryable: false,
          },
        },
      });
      continue;
    }

    const result = await callMcpTool(step.name, step.args, {
      rootDir: options.rootDir ?? rootDir,
      env,
      now: options.now,
      fetchImpl: options.fetchImpl,
      aiProvider: options.aiProvider,
      timeoutMs: parsePositiveInteger(env.TELEGRAM_AI_AGENT_TIMEOUT_MS, null),
    });
    toolResults.push({
      name: step.name,
      args: step.args,
      result,
    });
  }

  const generateAgentReply = options.generateAgentReply ?? defaultGenerateAgentReply;
  return normalizeAgentReply(await generateAgentReply({
    question,
    toolResults,
    env,
    aiProvider: options.aiProvider,
    fetchImpl: options.fetchImpl,
  }));
}

export function buildTelegramAiAgentPlan(question) {
  const normalized = normalizeAgentQuestion(question);

  if (hasRuntimeStatusIntent(normalized)) {
    return [
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
    ];
  }

  if (hasCommandHelpIntent(normalized)) {
    return [
      {
        name: 'telegram.get_command_registry',
        args: {},
      },
    ];
  }

  if (hasSearchIntent(normalized)) {
    return [
      {
        name: 'training.search_records',
        args: {
          query: extractSearchQuery(normalized),
          types: ['snapshot', 'markdown', 'thought'],
          limit: 5,
        },
      },
    ];
  }

  if (hasNutritionIntent(normalized)) {
    return [
      {
        name: 'training.get_nutrition',
        args: resolveQuestionDateWindow(normalized),
      },
      {
        name: 'training.generate_analysis',
        args: {
          question: normalized,
        },
      },
    ];
  }

  if (hasBodyFeedbackIntent(normalized)) {
    return [
      {
        name: 'training.get_body_feedback',
        args: {
          ...resolveQuestionDateWindow(normalized),
          limit: 10,
        },
      },
      {
        name: 'training.get_activities',
        args: {
          ...resolveQuestionDateWindow(normalized),
          limit: 20,
        },
      },
      {
        name: 'training.generate_analysis',
        args: {
          question: normalized,
        },
      },
    ];
  }

  return [
    {
      name: 'training.get_latest_status',
      args: {},
    },
    {
      name: 'training.get_analysis_summary',
      args: resolveQuestionDateWindow(normalized),
    },
    {
      name: 'training.generate_analysis',
      args: {
        question: normalized,
      },
    },
  ];
}

async function defaultGenerateAgentReply({ question, toolResults, env, aiProvider, fetchImpl }) {
  const provider = aiProvider ?? createAiProvider(env);
  const response = await provider.requestChatCompletion({
    messages: [
      {
        role: 'system',
        content: [
          '你是训练记录系统的 Telegram AI 助手。',
          '根据工具结果回答用户问题，保持中文短回复。',
          '必须说明关键结论来自哪些数据；不要编造缺失数据。',
          '疼痛或不适问题只能做训练诱因和风险提示，不能做医学诊断。',
          '如果工具失败，简短说明当前不能确认的原因。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `question: ${question}`,
          `tool_results: ${JSON.stringify(summarizeToolResults(toolResults))}`,
        ].join('\n'),
      },
    ],
    fetchImpl,
    logPrefix: '[telegram-ai-agent]',
    finalErrorMessage: 'Telegram AI agent request failed',
  });

  if (!response.ok) {
    throw new Error(`Telegram AI agent failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Telegram AI agent returned empty content');
  }
  return content;
}

function summarizeToolResults(toolResults) {
  return toolResults.map((item) => ({
    name: item.name,
    args: item.args,
    success: item.result?.success ?? false,
    data: item.result?.data ?? null,
    error: item.result?.error ?? null,
    meta: item.result?.meta ?? null,
  }));
}

function normalizeAgentQuestion(question) {
  return String(question ?? '').trim() || '请结合当前训练记录回答我的问题';
}

function normalizeAgentReply(reply) {
  const normalized = String(reply ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('Telegram AI agent returned empty reply');
  }
  return normalized;
}

function hasRuntimeStatusIntent(question) {
  return /同步|pending|失败|队列|状态|健康|正常|配置|数据源|database|markdown|MCP|mcp/u.test(question);
}

function hasCommandHelpIntent(question) {
  return /命令|指令|怎么用|用法|帮助|help/u.test(question);
}

function hasSearchIntent(question) {
  return /搜|搜索|查找|找一下|找下|历史|记录/u.test(question);
}

function hasNutritionIntent(question) {
  return /饮食|吃|摄入|热量|蛋白|碳水|脂肪|餐/u.test(question);
}

function hasBodyFeedbackIntent(question) {
  return /疼|痛|酸痛|酸胀|不适|恢复|疲劳|累|肩|肘|腕|膝|腰|背|臀|髋|踝/u.test(question);
}

function extractSearchQuery(question) {
  const cleaned = question
    .replace(/^(?:帮我)?(?:搜一下|搜索|查找|找一下|找下)\s*/u, '')
    .replace(/(?:相关)?(?:历史)?记录[？?。!！]*$/u, '')
    .trim();
  return cleaned || question;
}

function resolveQuestionDateWindow(question) {
  if (/(?:最近|近|过去|这|本)?\s*(?:7|七)\s*天|(?:一|1)\s*周/u.test(question)) {
    return {
      date_from: dateDaysAgo(6),
      date_to: today(),
    };
  }
  if (/(?:最近|近|过去)?\s*(?:30|三十)\s*天|(?:一|1)\s*个?\s*月/u.test(question)) {
    return {
      date_from: dateDaysAgo(29),
      date_to: today(),
    };
  }
  return {};
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function parseAllowedTools(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return defaultAllowedTools;
  }
  return new Set(text.split(',').map((item) => item.trim()).filter(Boolean));
}

function isToolAllowed(name, allowedTools) {
  return allowedTools.has(name);
}

function parsePositiveInteger(value, fallback) {
  if (value === null) {
    return fallback;
  }
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

