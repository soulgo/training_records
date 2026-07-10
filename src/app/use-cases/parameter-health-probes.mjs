import pg from 'pg';
import COS from 'cos-nodejs-sdk-v5';

const DEFAULT_TIMEOUT_MS = 5000;
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

export async function runParameterHealthProbes(registry, options = {}) {
  const probes = Array.isArray(registry?.probes) ? registry.probes : [];
  const runProbe = options.runProbe ?? ((probe) => runParameterHealthProbe(probe, options));
  const entries = await Promise.all(probes.map(async (probe) => {
    try {
      return [probe.key, await runProbe(probe)];
    } catch {
      return [probe.key, {
        probeKey: probe.key,
        checkType: probe.type,
        checkedAt: new Date().toISOString(),
        status: 'unknown',
        failureKind: 'probe_runner_error',
        evidenceSource: 'active_probe',
        latencyMs: 0,
        observedExpiresAt: null,
        message: '健康探测执行异常',
        details: {},
      }];
    }
  }));
  return new Map(entries);
}

export async function runParameterHealthProbe(probe, options = {}) {
  const checkedAt = normalizeDate(options.now) ?? new Date();
  const checkType = normalizeText(probe?.type) ?? 'unsupported';
  const probeKey = normalizeText(probe?.key) ?? 'unknown';
  const startedAt = Date.now();
  const base = {
    probeKey,
    checkType,
    checkedAt: checkedAt.toISOString(),
    status: 'unknown',
    failureKind: null,
    evidenceSource: `active_probe:${checkType}`,
    latencyMs: 0,
    observedExpiresAt: null,
    message: '健康状态未知',
    details: {},
  };

  if (checkType === 'unsupported') {
    return finish(base, startedAt, {
      status: 'unsupported',
      failureKind: 'no_safe_probe',
      evidenceSource: 'registry',
      message: '当前没有安全且可靠的自动探测方式',
    });
  }

  const env = options.env ?? {};
  if (checkType === 'presence') {
    const envName = normalizeText(probe?.env?.value);
    const present = Boolean(envName && normalizeText(env[envName]));
    return finish(base, startedAt, {
      status: present ? 'present' : 'missing',
      failureKind: present ? null : 'credential_missing',
      evidenceSource: 'runtime_env_presence',
      message: present ? '参数已注入；未执行外部鉴权' : '参数未注入',
      details: envName ? { checkedEnvNames: [envName] } : {},
    });
  }

  try {
    if (checkType === 'postgres_connect') {
      return finish(base, startedAt, await probePostgres(probe, { ...options, env }));
    }
    if (checkType === 'openai_models') {
      return finish(base, startedAt, await probeOpenAiModels(probe, { ...options, env }));
    }
    if (checkType === 'telegram_get_me') {
      return finish(base, startedAt, await probeTelegram(probe, { ...options, env }));
    }
    if (checkType === 'feishu_tenant_token') {
      return finish(base, startedAt, await probeFeishu(probe, { ...options, env }));
    }
    if (checkType === 'cos_head_bucket') {
      return finish(base, startedAt, await probeCos(probe, { ...options, env }));
    }
    if (checkType === 'cloudflare_token_verify') {
      return finish(base, startedAt, await probeCloudflareToken(probe, { ...options, env }));
    }
    return finish(base, startedAt, {
      status: 'unsupported',
      failureKind: 'no_probe_implementation',
      evidenceSource: 'registry',
      message: `尚未实现 ${checkType} 健康探测`,
    });
  } catch (error) {
    const failureKind = error?.name === 'AbortError' ? 'timeout' : 'network';
    return finish(base, startedAt, {
      status: 'unreachable',
      failureKind,
      message: failureKind === 'timeout' ? '健康探测超时' : '健康探测网络不可达',
    });
  }
}

async function probePostgres(probe, { env, createPgClient }) {
  const connectionString = readRequiredEnv(probe, env, 'url');
  if (!connectionString) {
    return missingCredential();
  }
  const clientFactory = createPgClient ?? ((config) => new pg.Client(config));
  const client = clientFactory({
    connectionString,
    application_name: 'parameter-health-probe',
    connectionTimeoutMillis: normalizePositiveInteger(probe.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query('select 1 as ok');
    return {
      status: 'healthy',
      failureKind: null,
      evidenceSource: 'active_probe:postgres_connect',
      message: 'PostgreSQL 连接与只读查询成功',
      details: { query: 'select_1' },
    };
  } catch (error) {
    if (error?.code === '28P01' || error?.code === '28000') {
      return {
        status: 'invalid',
        failureKind: 'authentication',
        evidenceSource: 'active_probe:postgres_connect',
        message: 'PostgreSQL 拒绝凭证',
        details: { providerCode: String(error.code) },
      };
    }
    return {
      status: 'unreachable',
      failureKind: error?.code === 'ETIMEDOUT' ? 'timeout' : 'network',
      evidenceSource: 'active_probe:postgres_connect',
      message: 'PostgreSQL 连接不可达',
      details: { providerCode: normalizeText(error?.code) },
    };
  } finally {
    await client.end?.().catch(() => {});
  }
}

async function probeOpenAiModels(probe, { env, fetchImpl = globalThis.fetch }) {
  const token = readRequiredEnv(probe, env, 'token');
  const baseUrl = readRequiredEnv(probe, env, 'baseUrl');
  if (!token || !baseUrl) {
    return missingCredential();
  }
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl.replace(/\/+$/u, '')}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, probe.timeoutMs);
  if (AUTH_FAILURE_STATUSES.has(response.status)) {
    return invalidAuthentication(response.status);
  }
  if (!response.ok) {
    return providerFailure(response.status);
  }
  return {
    status: 'healthy',
    failureKind: null,
    evidenceSource: 'active_probe:openai_models',
    message: 'AI Provider 鉴权成功',
    details: { httpStatus: response.status },
  };
}

async function probeFeishu(probe, { env, fetchImpl = globalThis.fetch }) {
  const appId = readRequiredEnv(probe, env, 'appId');
  const appSecret = readRequiredEnv(probe, env, 'appSecret');
  if (!appId || !appSecret) {
    return missingCredential();
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    probe.timeoutMs,
  );
  if (AUTH_FAILURE_STATUSES.has(response.status)) {
    return invalidAuthentication(response.status);
  }
  if (!response.ok) {
    return providerFailure(response.status);
  }
  const payload = await readJson(response);
  if (payload?.code === 0 && normalizeText(payload?.tenant_access_token)) {
    return {
      status: 'healthy',
      failureKind: null,
      evidenceSource: 'active_probe:feishu_tenant_token',
      message: '飞书应用凭证鉴权成功',
      details: { httpStatus: response.status, providerCode: 0 },
    };
  }
  return {
    status: 'invalid',
    failureKind: 'authentication',
    evidenceSource: 'active_probe:feishu_tenant_token',
    message: '飞书应用凭证鉴权失败',
    details: { httpStatus: response.status, providerCode: Number(payload?.code) || null },
  };
}

async function probeCos(probe, { env, createCosClient }) {
  const secretId = readRequiredEnv(probe, env, 'secretId');
  const secretKey = readRequiredEnv(probe, env, 'secretKey');
  const bucket = readRequiredEnv(probe, env, 'bucket');
  const region = readRequiredEnv(probe, env, 'region');
  if (!secretId || !secretKey || !bucket || !region) {
    return missingCredential();
  }
  const clientFactory = createCosClient ?? ((config) => new COS(config));
  const client = clientFactory({ SecretId: secretId, SecretKey: secretKey });
  try {
    const data = await withPromiseTimeout(new Promise((resolve, reject) => {
      client.headBucket({ Bucket: bucket, Region: region }, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    }), probe.timeoutMs);
    return {
      status: 'healthy',
      failureKind: null,
      evidenceSource: 'active_probe:cos_head_bucket',
      message: '腾讯 COS Bucket 访问验证成功',
      details: { httpStatus: Number(data?.statusCode) || 200 },
    };
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.status);
    if (AUTH_FAILURE_STATUSES.has(statusCode)) {
      return invalidAuthentication(statusCode);
    }
    return {
      status: 'unreachable',
      failureKind: error?.name === 'AbortError' ? 'timeout' : 'provider_error',
      evidenceSource: 'active_probe:cos_head_bucket',
      message: error?.name === 'AbortError' ? '腾讯 COS 探测超时' : '腾讯 COS 暂时不可用',
      details: { httpStatus: Number.isFinite(statusCode) ? statusCode : null },
    };
  }
}

async function probeTelegram(probe, { env, fetchImpl = globalThis.fetch }) {
  const token = readRequiredEnv(probe, env, 'token');
  if (!token) {
    return missingCredential();
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    `https://api.telegram.org/bot${token}/getMe`,
    { method: 'GET' },
    probe.timeoutMs,
  );
  if (AUTH_FAILURE_STATUSES.has(response.status)) {
    return invalidAuthentication(response.status);
  }
  if (!response.ok) {
    return providerFailure(response.status);
  }
  const payload = await readJson(response);
  if (payload?.ok === true) {
    return {
      status: 'healthy',
      failureKind: null,
      evidenceSource: 'active_probe:telegram_get_me',
      message: 'Telegram Bot 鉴权成功',
      details: { httpStatus: response.status, providerStatus: 'ok' },
    };
  }
  return {
    status: 'invalid',
    failureKind: 'authentication',
    evidenceSource: 'active_probe:telegram_get_me',
    message: 'Telegram Bot 鉴权失败',
    details: { httpStatus: response.status, providerStatus: 'rejected' },
  };
}

async function probeCloudflareToken(probe, { env, fetchImpl = globalThis.fetch }) {
  const token = readRequiredEnv(probe, env, 'token');
  if (!token) {
    return missingCredential();
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    probe.timeoutMs,
  );
  if (AUTH_FAILURE_STATUSES.has(response.status)) {
    return invalidAuthentication(response.status);
  }
  if (!response.ok) {
    return providerFailure(response.status);
  }
  const payload = await readJson(response);
  const providerStatus = normalizeText(payload?.result?.status);
  if (payload?.success === true && providerStatus === 'active') {
    return {
      status: 'healthy',
      failureKind: null,
      evidenceSource: 'active_probe:cloudflare_token_verify',
      message: 'Cloudflare Token 验证通过',
      observedExpiresAt: normalizeIso(payload?.result?.expires_on),
      details: { httpStatus: response.status, providerStatus },
    };
  }
  return {
    status: 'invalid',
    failureKind: 'authentication',
    evidenceSource: 'active_probe:cloudflare_token_verify',
    message: 'Cloudflare Token 未处于 active 状态',
    observedExpiresAt: normalizeIso(payload?.result?.expires_on),
    details: { httpStatus: response.status, providerStatus: providerStatus ?? 'rejected' },
  };
}

function readRequiredEnv(probe, env, role) {
  const envName = normalizeText(probe?.env?.[role]);
  return envName ? normalizeText(env[envName]) : null;
}

function missingCredential() {
  return {
    status: 'missing',
    failureKind: 'credential_missing',
    evidenceSource: 'runtime_env_presence',
    message: '探测所需凭证未注入',
  };
}

function invalidAuthentication(httpStatus) {
  return {
    status: 'invalid',
    failureKind: 'authentication',
    message: 'Provider 拒绝凭证',
    details: { httpStatus },
  };
}

function providerFailure(httpStatus) {
  return {
    status: 'unreachable',
    failureKind: httpStatus === 429 ? 'rate_limited' : 'provider_error',
    message: httpStatus === 429 ? 'Provider 限流，无法判断凭证状态' : 'Provider 暂时不可用',
    details: { httpStatus },
  };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch is unavailable');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInteger(timeoutMs) ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function withPromiseTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('probe timeout');
      error.name = 'AbortError';
      reject(error);
    }, normalizePositiveInteger(timeoutMs) ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function finish(base, startedAt, patch) {
  return {
    ...base,
    ...patch,
    latencyMs: Math.max(0, Date.now() - startedAt),
    observedExpiresAt: normalizeIso(patch?.observedExpiresAt ?? base.observedExpiresAt),
    details: sanitizeDetails(patch?.details ?? base.details),
  };
}

function sanitizeDetails(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDetails);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(value|secret|token|password|api[_-]?key|url)/iu.test(key)) {
      continue;
    }
    safe[key] = sanitizeDetails(entry);
  }
  return safe;
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeIso(value) {
  return normalizeDate(value)?.toISOString() ?? null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
