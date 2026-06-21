import { downloadBinaryWithLimit } from '../http/download-binary.mjs';

const FEISHU_API_BASE_URL = 'https://open.feishu.cn';
const tokenCache = new Map();
const tokenRefreshPromises = new Map();

export async function getFeishuTenantAccessToken({
  appId,
  appSecret,
  fetch: fetchImpl = globalThis.fetch,
  apiBaseUrl = FEISHU_API_BASE_URL,
  now = Date.now,
  cacheKey = 'default',
} = {}) {
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  }

  const cached = tokenCache.get(cacheKey);
  const nowMs = now();
  if (cached?.token && cached.expiresAt > nowMs) {
    return cached.token;
  }

  const existingRefresh = tokenRefreshPromises.get(cacheKey);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = refreshFeishuTenantAccessToken({
    appId,
    appSecret,
    fetchImpl,
    apiBaseUrl,
    nowMs,
    cacheKey,
  }).finally(() => {
    tokenRefreshPromises.delete(cacheKey);
  });
  tokenRefreshPromises.set(cacheKey, refreshPromise);
  return refreshPromise;
}

async function refreshFeishuTenantAccessToken({
  appId,
  appSecret,
  fetchImpl,
  apiBaseUrl,
  nowMs,
  cacheKey,
}) {
  const response = await fetchImpl(`${apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Feishu tenant_access_token failed: ${payload.msg ?? 'missing token'}`);
  }

  const ttlSeconds = Math.max(60, Number(payload.expire ?? 7200) - 300);
  tokenCache.set(cacheKey, {
    token: payload.tenant_access_token,
    expiresAt: nowMs + ttlSeconds * 1000,
  });
  return payload.tenant_access_token;
}

export async function sendFeishuMessage({
  appId,
  appSecret,
  tenantAccessToken,
  chatId,
  text,
  fetch: fetchImpl = globalThis.fetch,
  apiBaseUrl = FEISHU_API_BASE_URL,
} = {}) {
  const token =
    tenantAccessToken ??
    await getFeishuTenantAccessToken({ appId, appSecret, fetch: fetchImpl, apiBaseUrl });
  if (!chatId) {
    throw new Error('Feishu chatId is required');
  }

  const response = await fetchImpl(`${apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text ?? '') }),
    }),
  });
  if (!response.ok) {
    throw new Error(`Feishu sendMessage failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`Feishu sendMessage failed: ${payload.msg ?? 'unknown error'}`);
  }
  return payload;
}

export async function fetchFeishuImageResource({
  appId,
  appSecret,
  tenantAccessToken,
  messageId,
  imageKey,
  fetch: fetchImpl = globalThis.fetch,
  apiBaseUrl = FEISHU_API_BASE_URL,
  maxDownloadBytes,
} = {}) {
  const token =
    tenantAccessToken ??
    await getFeishuTenantAccessToken({ appId, appSecret, fetch: fetchImpl, apiBaseUrl });
  if (!messageId || !imageKey) {
    throw new Error('Feishu messageId and imageKey are required');
  }

  const response = await fetchImpl(
    `${apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu image download failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const data = await downloadBinaryWithLimit(response, {
    maxBytes: maxDownloadBytes,
    label: 'Feishu image download',
  });
  return {
    data,
    contentType,
    filePath: `${imageKey}${extensionFromContentType(contentType)}`,
  };
}

function extensionFromContentType(value) {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/tiff': '.tiff',
  }[contentType] ?? '';
}
