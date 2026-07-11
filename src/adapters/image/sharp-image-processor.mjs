import sharp from 'sharp';

const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_MAX_PIXELS = 4_000_000;
const DEFAULT_JPEG_QUALITY = 84;

export async function processRecognitionImage({
  imageUrl,
  fetchImpl = globalThis.fetch,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  maxDimension = DEFAULT_MAX_DIMENSION,
  maxPixels = DEFAULT_MAX_PIXELS,
  jpegQuality = DEFAULT_JPEG_QUALITY,
} = {}) {
  const source = await readImageSource({ imageUrl, fetchImpl, maxInputBytes });
  const pipeline = sharp(source.data, {
    failOn: 'error',
    limitInputPixels: Math.max(maxPixels * 8, maxPixels),
  });
  const original = await pipeline.metadata();
  if (!original.width || !original.height) {
    throw new Error('recognition image dimensions are unavailable');
  }

  const oriented = getOrientedDimensions(original);
  const scale = Math.min(
    1,
    maxDimension / Math.max(oriented.width, oriented.height),
    Math.sqrt(maxPixels / (oriented.width * oriented.height)),
  );
  const width = Math.max(1, Math.floor(oriented.width * scale));
  const height = Math.max(1, Math.floor(oriented.height * scale));

  const output = await pipeline
    .rotate()
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .normalize()
    .sharpen()
    .jpeg({ quality: clampInteger(jpegQuality, 50, 95), mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    imageUrl: `data:image/jpeg;base64,${output.data.toString('base64')}`,
    metadata: {
      original: {
        format: original.format ?? (source.contentType.replace(/^image\//, '') || null),
        width: original.width,
        height: original.height,
        bytes: source.data.byteLength,
        contentType: source.contentType,
      },
      processed: {
        format: output.info.format,
        width: output.info.width,
        height: output.info.height,
        bytes: output.info.size,
        contentType: 'image/jpeg',
      },
      operations: ['autoRotate', 'resize', 'normalize', 'sharpen', 'jpeg'],
    },
  };
}

async function readImageSource({ imageUrl, fetchImpl, maxInputBytes }) {
  const value = String(imageUrl ?? '').trim();
  if (!value) {
    throw new Error('recognition image input is empty');
  }
  if (value.startsWith('data:')) {
    return readDataUrl(value, maxInputBytes);
  }

  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('recognition image URL must use HTTPS');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('recognition image download requires fetch support');
  }
  const response = await fetchImpl(url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`recognition image download failed with HTTP ${response.status}`);
  }
  const contentType = normalizeImageContentType(response.headers.get('content-type'));
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxInputBytes) {
    throw new Error(`recognition image exceeds ${maxInputBytes} byte limit`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  assertByteLimit(data, maxInputBytes);
  return { data, contentType };
}

function readDataUrl(value, maxInputBytes) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) {
    throw new Error('recognition image data URL must be base64 encoded');
  }
  const contentType = normalizeImageContentType(match[1]);
  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  assertByteLimit(data, maxInputBytes);
  return { data, contentType };
}

function normalizeImageContentType(value) {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`recognition image has unsupported content-type: ${contentType || 'unknown'}`);
  }
  return contentType;
}

function assertByteLimit(data, maxInputBytes) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error('recognition image byte limit must be a positive integer');
  }
  if (data.byteLength > maxInputBytes) {
    throw new Error(`recognition image exceeds ${maxInputBytes} byte limit`);
  }
}

function getOrientedDimensions(metadata) {
  const swapsAxes = metadata.orientation >= 5 && metadata.orientation <= 8;
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function clampInteger(value, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? Math.round(number) : DEFAULT_JPEG_QUALITY));
}
