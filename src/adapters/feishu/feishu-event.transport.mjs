import {
  readGithubEventFile,
  readInlineDispatchPayload,
  shouldReadDispatchEventFile,
} from '../../shared/dispatch-payload.mjs';

export async function resolveDispatchFeishuUpdates({
  repositoryDispatchEvent,
  githubEventName,
  githubEventPath,
  dispatchPayload,
}) {
  const eventPayload =
    repositoryDispatchEvent ??
    readInlineDispatchPayload(dispatchPayload) ??
    (shouldReadDispatchEventFile({ githubEventName, githubEventPath })
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
