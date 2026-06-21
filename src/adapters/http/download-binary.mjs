export const DEFAULT_MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export function resolveMaxDownloadBytes(value, fallback = DEFAULT_MAX_IMAGE_DOWNLOAD_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export async function downloadBinaryWithLimit(response, {
  maxBytes = DEFAULT_MAX_IMAGE_DOWNLOAD_BYTES,
  label = 'file download',
} = {}) {
  const limit = resolveMaxDownloadBytes(maxBytes);
  const contentLength = parseContentLength(response?.headers?.get?.('content-length'));
  if (contentLength !== null && contentLength > limit) {
    throw new Error(`${label} exceeds ${limit} bytes (content-length ${contentLength})`);
  }

  if (response?.body?.getReader) {
    return readStreamWithLimit(response.body, { maxBytes: limit, label });
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > limit) {
    throw new Error(`${label} exceeds ${limit} bytes (${data.byteLength} bytes received)`);
  }
  return data;
}

function parseContentLength(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

async function readStreamWithLimit(stream, { maxBytes, label }) {
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = normalizeChunk(value);
      const nextTotal = totalBytes + chunk.byteLength;
      if (nextTotal > maxBytes) {
        await cancelReader(reader);
        throw new Error(`${label} exceeds ${maxBytes} bytes (${nextTotal} bytes received)`);
      }
      chunks.push(chunk);
      totalBytes = nextTotal;
    }
  } finally {
    reader.releaseLock?.();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function normalizeChunk(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancellation failures; the original size-limit error is the useful signal.
  }
}
