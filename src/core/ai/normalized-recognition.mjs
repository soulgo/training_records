export const RECOGNITION_PIPELINE_VERSION = 'v2';

export function buildNormalizedRecognition({ payload, runtime, ocr = null, image = null }) {
  return {
    sourceApp: payload?.detectedApp ?? null,
    dataType: payload?.imageType ?? 'unknown',
    fields: payload?.records ?? {},
    confidence: normalizeConfidence(payload?.confidence),
    warnings: Array.isArray(payload?.warnings) ? [...payload.warnings] : [],
    evidence: {
      detectedDate: payload?.detectedDate ?? null,
      dateEvidence: payload?.dateEvidence ?? null,
      ocr,
      image,
    },
    runtime: {
      pipelineVersion: RECOGNITION_PIPELINE_VERSION,
      schemaName: runtime?.schemaName ?? null,
      schemaVersion: runtime?.schemaVersion ?? null,
      provider: runtime?.provider ?? null,
      model: runtime?.model ?? null,
      promptVersion: runtime?.promptVersion ?? null,
      cacheKey: runtime?.cacheKey ?? null,
      cacheStatus: runtime?.cacheStatus ?? 'disabled',
      completeness: runtime?.completeness ?? null,
      reconciliation: runtime?.reconciliation ?? null,
      fallbackModel: runtime?.fallbackModel ?? null,
    },
  };
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
}
