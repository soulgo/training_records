import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchTelegramFile } from '../src/adapters/telegram/telegram-api.mjs';

test('fetchTelegramFile rejects images above the configured content-length before reading the body', async () => {
  let imageBodyRead = false;
  const fetchCalls = [];

  await assert.rejects(
    fetchTelegramFile({
      botToken: 'telegram-token',
      fileId: 'file-large',
      maxDownloadBytes: 20 * 1024 * 1024,
      fetch: async (url) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/getFile?')) {
          return Response.json({
            ok: true,
            result: {
              file_path: 'photos/large.jpg',
            },
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
    /Telegram file download exceeds 20971520 bytes/i,
  );

  assert.equal(fetchCalls.length, 2);
  assert.equal(imageBodyRead, false);
});

test('fetchTelegramFile aborts streaming downloads without content-length after the byte limit', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let chunksSent = 0;

  await assert.rejects(
    fetchTelegramFile({
      botToken: 'telegram-token',
      fileId: 'file-stream',
      maxDownloadBytes: 2 * 1024 * 1024,
      fetch: async (url) => {
        if (String(url).includes('/getFile?')) {
          return Response.json({
            ok: true,
            result: {
              file_path: 'photos/stream.png',
            },
          });
        }
        return new Response(
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
        );
      },
    }),
    /Telegram file download exceeds 2097152 bytes/i,
  );
});
