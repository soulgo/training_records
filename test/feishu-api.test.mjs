import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchFeishuImageResource,
  getFeishuTenantAccessToken,
} from '../src/adapters/feishu/feishu-api.mjs';

test('getFeishuTenantAccessToken shares one in-flight refresh across concurrent callers', async () => {
  let tokenRequests = 0;
  let releaseTokenResponse;
  const tokenResponseReady = new Promise((resolve) => {
    releaseTokenResponse = resolve;
  });
  const fetchCalls = [];

  const requests = Array.from({ length: 10 }, () =>
    getFeishuTenantAccessToken({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiBaseUrl: 'https://feishu.example.com',
      cacheKey: 'concurrent-token-test',
      now: () => Date.parse('2026-06-20T10:00:00.000Z'),
      fetch: async (url, init) => {
        tokenRequests += 1;
        fetchCalls.push({ url: String(url), init });
        await tokenResponseReady;
        return Response.json({
          code: 0,
          tenant_access_token: 'tenant-token-concurrent',
          expire: 7200,
        });
      },
    })
  );

  await Promise.resolve();
  assert.equal(tokenRequests, 1);

  releaseTokenResponse();
  const tokens = await Promise.all(requests);

  assert.deepEqual(tokens, Array(10).fill('tenant-token-concurrent'));
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /tenant_access_token\/internal/);
});

test('fetchFeishuImageResource rejects images above the configured content-length before reading the body', async () => {
  let imageBodyRead = false;
  const fetchCalls = [];

  await assert.rejects(
    fetchFeishuImageResource({
      appId: 'app-id',
      appSecret: 'app-secret',
      messageId: 'om-large-image',
      imageKey: 'img-large',
      apiBaseUrl: 'https://feishu.example.com',
      maxDownloadBytes: 20 * 1024 * 1024,
      fetch: async (url) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/tenant_access_token/internal')) {
          return Response.json({
            code: 0,
            tenant_access_token: 'tenant-token-large',
            expire: 7200,
          });
        }
        return {
          ok: true,
          headers: new Headers({
            'content-length': String(25 * 1024 * 1024),
            'content-type': 'image/jpeg',
          }),
          async arrayBuffer() {
            imageBodyRead = true;
            return new ArrayBuffer(0);
          },
        };
      },
    }),
    /Feishu image download exceeds 20971520 bytes/i,
  );

  assert.equal(fetchCalls.length, 2);
  assert.equal(imageBodyRead, false);
});

test('fetchFeishuImageResource aborts streaming downloads without content-length after the byte limit', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let chunksSent = 0;

  await assert.rejects(
    fetchFeishuImageResource({
      tenantAccessToken: 'tenant-token-stream',
      messageId: 'om-stream-image',
      imageKey: 'img-stream',
      apiBaseUrl: 'https://feishu.example.com',
      maxDownloadBytes: 2 * 1024 * 1024,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunksSent += 1;
              controller.enqueue(chunk);
              if (chunksSent === 3) {
                controller.close();
              }
            },
          }),
          {
            headers: {
              'content-type': 'image/png',
            },
          },
        ),
    }),
    /Feishu image download exceeds 2097152 bytes/i,
  );
});
