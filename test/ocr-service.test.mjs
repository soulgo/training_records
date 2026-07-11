import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenAiCompatibleOcrService } from '../src/adapters/ocr/openai-compatible-ocr.adapter.mjs';

test('OpenAI-compatible OCR returns text blocks with bounded coordinates', async () => {
  let request = null;
  const service = createOpenAiCompatibleOcrService({
    aiProvider: {
      name: 'openai-compatible',
      env: { model: 'vision-ocr' },
      async requestChatCompletion(input) {
        request = input;
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: JSON.stringify({
                text: 'Sleep\n7 hr 30 min',
                language: 'en',
                confidence: 1.2,
                blocks: [
                  { text: 'Sleep', confidence: 0.98, bbox: { x: -0.1, y: 0.1, width: 0.4, height: 0.08 } },
                  { text: '7 hr 30 min', confidence: 0.94, bbox: { x: 0.2, y: 0.25, width: 1.2, height: 0.1 } },
                ],
              }) } }],
            };
          },
        };
      },
    },
  });

  const result = await service.extract({ imageUrl: 'data:image/jpeg;base64,image' });

  assert.equal(request.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,image');
  assert.equal(request.responseFormat.type, 'json_schema');
  assert.equal(result.text, 'Sleep\n7 hr 30 min');
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.model, 'vision-ocr');
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.blocks[0].bbox, { x: 0, y: 0.1, width: 0.4, height: 0.08 });
  assert.deepEqual(result.blocks[1].bbox, { x: 0.2, y: 0.25, width: 0.8, height: 0.1 });
});

test('OpenAI-compatible OCR fails explicitly on invalid provider output', async () => {
  const service = createOpenAiCompatibleOcrService({
    aiProvider: {
      env: { model: 'vision-ocr' },
      async requestChatCompletion() {
        return { ok: true, async json() { return { choices: [{ message: { content: '{bad json' } }] }; } };
      },
    },
  });

  await assert.rejects(service.extract({ imageUrl: 'data:image/jpeg;base64,image' }), /OCR returned invalid JSON/);
});
