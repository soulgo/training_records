const ANALYSIS_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function requestTrainingAnalysis({
  aiProvider,
  prompt,
  question,
  focus,
  summary,
  fetchImpl,
  maxAttempts,
  baseDelayMs,
}) {
  const response = await aiProvider.requestChatCompletion({
    messages: [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: [
          `Q: ${question}`,
          `focus: ${JSON.stringify(focus)}`,
          `data: ${JSON.stringify(summary)}`,
        ].join('\n'),
      },
    ],
    fetchImpl,
    maxAttempts,
    baseDelayMs,
    retryableStatuses: ANALYSIS_RETRYABLE_STATUSES,
    logPrefix: '[training-analysis]',
    finalErrorMessage: 'Training analysis request failed',
  });

  if (!response.ok) {
    throw new Error(`Training analysis failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Training analysis returned empty content');
  }
  return content;
}

export function normalizeTelegramReply(content) {
  return String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function splitTelegramMessage(text, maxLength = 3900) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const parts = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakIndex = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('。'));
    const splitAt = breakIndex > maxLength * 0.5 ? breakIndex + 1 : maxLength;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}
