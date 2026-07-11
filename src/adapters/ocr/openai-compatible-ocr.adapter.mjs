import { normalizeOcrDocument } from '../../core/ai/ocr-document.mjs';

const OCR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'language', 'confidence', 'blocks'],
  properties: {
    text: { type: 'string' },
    language: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'confidence', 'bbox'],
        properties: {
          text: { type: 'string' },
          confidence: { type: 'number' },
          bbox: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
        },
      },
    },
  },
};

export function createOpenAiCompatibleOcrService({ aiProvider }) {
  if (typeof aiProvider?.requestChatCompletion !== 'function') {
    throw new Error('OCR service requires an AI provider');
  }
  return {
    async extract({ imageUrl }) {
      const response = await aiProvider.requestChatCompletion({
        messages: [
          {
            role: 'system',
            content: 'Extract every visible text block from the screenshot. Preserve reading order. Return normalized bounding boxes where x, y, width and height are between 0 and 1. Do not infer hidden text.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Perform OCR only and return the requested JSON.' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'ocr_document', strict: true, schema: OCR_SCHEMA },
        },
        logPrefix: '[ocr]',
        finalErrorMessage: 'OCR request failed',
      });
      if (!response.ok) {
        throw new Error(`OCR request failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      let value;
      try {
        value = typeof content === 'string' ? JSON.parse(content) : content;
      } catch (error) {
        throw new Error('OCR returned invalid JSON', { cause: error });
      }
      if (!value || typeof value !== 'object') {
        throw new Error('OCR returned invalid JSON');
      }
      return normalizeOcrDocument(value, {
        provider: aiProvider.name ?? 'openai-compatible',
        model: aiProvider.env?.model ?? null,
      });
    },
  };
}
