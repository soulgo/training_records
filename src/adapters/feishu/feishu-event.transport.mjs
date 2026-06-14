import { readFile } from 'node:fs/promises';

export async function resolveDispatchFeishuUpdates({
  repositoryDispatchEvent,
  githubEventName,
  githubEventPath,
}) {
  const eventPayload =
    repositoryDispatchEvent ??
    (githubEventName === 'repository_dispatch' && githubEventPath
      ? await readGithubEventFile(githubEventPath)
      : null);

  if (!eventPayload) {
    return null;
  }

  const clientPayload = eventPayload.client_payload ?? {};
  if (clientPayload.feishu_update) {
    return [clientPayload.feishu_update];
  }
  if (Array.isArray(clientPayload.feishu_updates)) {
    return clientPayload.feishu_updates;
  }
  return [];
}

async function readGithubEventFile(eventPath) {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
