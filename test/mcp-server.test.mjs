import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpJsonRpcHandler } from '../src/mcp/server.mjs';

test('MCP JSON-RPC handler lists tools', async () => {
  const handler = createMcpJsonRpcHandler();

  const response = await handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.ok(response.result.tools.some((tool) => tool.name === 'training.get_snapshot'));
});

test('MCP JSON-RPC handler calls tools and wraps content as JSON text', async () => {
  const handler = createMcpJsonRpcHandler({
    toolCaller: async (name, args) => ({
      success: true,
      trace_id: args.trace_id,
      data: { name },
      error: null,
      meta: { duration_ms: 1 },
    }),
  });

  const response = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'training.get_config',
      arguments: {
        trace_id: 'trace-1',
      },
    },
  });

  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    success: true,
    trace_id: 'trace-1',
    data: { name: 'training.get_config' },
    error: null,
    meta: { duration_ms: 1 },
  });
});

test('MCP JSON-RPC handler reports method errors', async () => {
  const handler = createMcpJsonRpcHandler();

  const response = await handler({
    jsonrpc: '2.0',
    id: 3,
    method: 'unknown/method',
  });

  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Method not found/);
});
