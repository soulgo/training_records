import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { processRecognitionImage } from '../src/adapters/image/sharp-image-processor.mjs';

test('processRecognitionImage rotates, constrains, enhances, and compresses screenshot input', async () => {
  const input = await sharp({
    create: {
      width: 1800,
      height: 3200,
      channels: 3,
      background: '#f4f4f4',
    },
  }).png().toBuffer();

  const result = await processRecognitionImage({
    imageUrl: `data:image/png;base64,${input.toString('base64')}`,
    maxDimension: 1200,
    maxPixels: 1_440_000,
    jpegQuality: 82,
  });

  assert.match(result.imageUrl, /^data:image\/jpeg;base64,/);
  assert.equal(result.metadata.original.format, 'png');
  assert.equal(result.metadata.original.width, 1800);
  assert.equal(result.metadata.original.height, 3200);
  assert.equal(result.metadata.processed.format, 'jpeg');
  assert.ok(result.metadata.processed.width <= 1200);
  assert.ok(result.metadata.processed.height <= 1200);
  assert.ok(result.metadata.processed.width * result.metadata.processed.height <= 1_440_000);
  assert.ok(result.metadata.processed.bytes < input.byteLength);
  assert.deepEqual(result.metadata.operations, ['autoRotate', 'resize', 'normalize', 'sharpen', 'jpeg']);
});

test('processRecognitionImage rejects oversized encoded input before image decoding', async () => {
  await assert.rejects(
    processRecognitionImage({
      imageUrl: `data:image/png;base64,${Buffer.alloc(128).toString('base64')}`,
      maxInputBytes: 64,
    }),
    /exceeds 64 byte limit/,
  );
});
