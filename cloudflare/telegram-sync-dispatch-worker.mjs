const GITHUB_API_BASE_URL = 'https://api.github.com';
const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

export default {
  async fetch(request, env) {
    return handleTelegramWebhook(request, env);
  },
};

export async function handleTelegramWebhook(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  }

  const configError = validateRequiredConfig(env);
  if (configError) {
    return jsonResponse(500, { ok: false, error: configError });
  }

  const expectedSecret = env.TELEGRAM_SECRET_TOKEN.trim();
  const providedSecret = request.headers.get(TELEGRAM_SECRET_HEADER) ?? '';
  if (providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid_json' });
  }

  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'telegram-sync-dispatch-worker',
      },
      body: JSON.stringify({
        event_type: 'telegram_update',
        client_payload: {
          telegram_update: update,
        },
      }),
    },
  );

  if (!response.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'github_dispatch_failed',
      status: response.status,
      body: await safeReadText(response),
    });
  }

  return jsonResponse(202, {
    ok: true,
    dispatched: true,
    updateId: update?.update_id ?? null,
  });
}

function validateRequiredConfig(env) {
  for (const name of ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN', 'TELEGRAM_SECRET_TOKEN']) {
    if (!env?.[name]?.trim()) {
      return `missing_${name.toLowerCase()}`;
    }
  }
  return null;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
