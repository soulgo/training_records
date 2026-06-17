import path from 'node:path';
import { readFile } from 'node:fs/promises';

export async function fetchTelegramUpdates({ botToken, offset, limit, fetch: fetchImpl = globalThis.fetch }) {
  const search = new URLSearchParams({
    timeout: '0',
    allowed_updates: JSON.stringify(['message', 'edited_message']),
    offset: String(offset),
    limit: String(limit),
  });
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/getUpdates?${search}`);
  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram getUpdates failed: ${payload.description ?? 'unknown error'}`);
  }
  return payload.result ?? [];
}

export async function resolveDispatchTelegramUpdates({
  repositoryDispatchEvent,
  githubEventName,
  githubEventPath,
}) {
  const eventPayload =
    repositoryDispatchEvent ??
    (shouldReadDispatchEventFile({ githubEventName, githubEventPath })
      ? await readGithubEventFile(githubEventPath)
      : null);

  if (!eventPayload) {
    return null;
  }

  const clientPayload = eventPayload.client_payload ?? {};
  if (clientPayload.telegram_update) {
    return [clientPayload.telegram_update];
  }
  if (Array.isArray(clientPayload.telegram_updates)) {
    return clientPayload.telegram_updates;
  }
  return [];
}

export function isDispatchEventName(value) {
  return value === 'repository_dispatch' || value === 'workflow_dispatch';
}

export function shouldReadDispatchEventFile({ githubEventName, githubEventPath }) {
  return Boolean(
    githubEventPath &&
      (isDispatchEventName(githubEventName) ||
        path.basename(githubEventPath) === 'queued-dispatch-event.json'),
  );
}

async function readGithubEventFile(eventPath) {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
