import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { callMcpTool, listMcpTools } from './tools.mjs';

const protocolVersion = '2024-11-05';

export function createMcpJsonRpcHandler(options = {}) {
  const toolCaller = options.toolCaller ?? callMcpTool;
  const toolLister = options.toolLister ?? listMcpTools;

  return async function handleJsonRpc(request) {
    try {
      if (!request || request.jsonrpc !== '2.0') {
        return errorResponse(request?.id ?? null, -32600, 'Invalid Request');
      }

      if (request.method === 'initialize') {
        return successResponse(request.id, {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'training-records-mcp',
            version: '1.0.0',
          },
        });
      }

      if (request.method === 'notifications/initialized') {
        return null;
      }

      if (request.method === 'tools/list') {
        return successResponse(request.id, {
          tools: toolLister(),
        });
      }

      if (request.method === 'tools/call') {
        const params = request.params ?? {};
        const result = await toolCaller(params.name, params.arguments ?? {}, options.toolOptions ?? {});
        return successResponse(request.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.success === false,
        });
      }

      return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      return errorResponse(
        request?.id ?? null,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

export async function runMcpStdioServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const handler = createMcpJsonRpcHandler(options);
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error'))}\n`);
      continue;
    }

    const response = await handler(request);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

function successResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await runMcpStdioServer();
}
