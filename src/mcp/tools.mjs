import { toolDefinitions, toolsByName } from './tool-catalog.mjs';
import {
  buildCacheKey,
  buildSuccessEnvelope,
  buildToolContext,
  McpToolError,
  normalizeToolError,
  normalizeTraceId,
  readCache,
  resolveEffectiveSource,
  resolveMcpConfig,
  runWithTimeout,
  validateCommonArgs,
  writeCache,
} from './tool-support.mjs';

export { resolveMcpConfig } from './tool-support.mjs';

export function listMcpTools() {
  return toolDefinitions.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export async function callMcpTool(name, args = {}, options = {}) {
  const env = options.env ?? process.env;
  const config = {
    ...resolveMcpConfig(env),
    ...(options.config ?? {}),
  };
  const startedAt = Date.now();
  const traceId = normalizeTraceId(args?.trace_id);
  const tool = toolsByName.get(name);

  try {
    if (!tool) {
      throw new McpToolError('TOOL_DISABLED', `Unknown MCP tool: ${name}`, { retryable: false });
    }
    if (!config.enabled) {
      throw new McpToolError('TOOL_DISABLED', 'MCP tools are disabled', { retryable: false });
    }
    if (config.allowedTools && !config.allowedTools.has(name)) {
      throw new McpToolError('UNAUTHORIZED', `MCP tool is not allowed: ${name}`, { retryable: false });
    }

    validateCommonArgs(args, config);
    const cacheKey = buildCacheKey(name, args, options);
    const cached = readCache(tool, cacheKey);
    if (cached) {
      return buildSuccessEnvelope({
        traceId,
        data: cached.data,
        meta: {
          ...cached.meta,
          cache: 'hit',
          duration_ms: Date.now() - startedAt,
        },
      });
    }

    const data = await runWithTimeout(
      tool.handler(args ?? {}, buildToolContext({ env, config, options })),
      options.timeoutMs ?? config.toolTimeoutMs,
    );
    const meta = {
      source: data?.source ?? resolveEffectiveSource(args?.source, env),
      generated_at: data?.generatedAt ?? data?.summary?.generatedAt ?? null,
      cache: tool.ttlMs ? 'miss' : 'disabled',
      duration_ms: Date.now() - startedAt,
    };
    const payload = data?.data !== undefined ? data.data : data;
    writeCache(tool, cacheKey, payload, meta);

    return buildSuccessEnvelope({ traceId, data: payload, meta });
  } catch (error) {
    const normalized = normalizeToolError(error);
    return {
      success: false,
      trace_id: traceId,
      data: null,
      error: normalized,
      meta: {
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}
