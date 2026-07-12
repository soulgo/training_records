export function normalizeOcrDocument(value, { provider = null, model = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OCR document must be an object');
  }
  const blocks = Array.isArray(value.blocks)
    ? value.blocks.map(normalizeBlock).filter(Boolean)
    : [];
  return {
    text: String(value.text ?? '').trim(),
    blocks,
    language: normalizeNullableText(value.language),
    confidence: clamp01(value.confidence),
    provider,
    model,
  };
}

function normalizeBlock(block) {
  const text = String(block?.text ?? '').trim();
  if (!text) {
    return null;
  }
  const x = clamp01(block?.bbox?.x);
  const y = clamp01(block?.bbox?.y);
  return {
    text,
    confidence: clamp01(block?.confidence),
    bbox: {
      x,
      y,
      width: Math.min(clamp01(block?.bbox?.width), 1 - x),
      height: Math.min(clamp01(block?.bbox?.height), 1 - y),
    },
  };
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function normalizeNullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
