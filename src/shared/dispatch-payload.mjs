import path from 'node:path';
import { readFile } from 'node:fs/promises';

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

export function readInlineDispatchPayload(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return normalizeInlineDispatchPayload(value);
  }
  try {
    return normalizeInlineDispatchPayload(JSON.parse(String(value)));
  } catch {
    return null;
  }
}

function normalizeInlineDispatchPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if ('client_payload' in payload) {
    return payload;
  }
  return {
    action: payload.action ?? '',
    client_payload: payload,
  };
}

export async function readGithubEventFile(eventPath) {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
