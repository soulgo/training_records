import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createGitHubActionReportHttpHandler } from '../src/app/use-cases/github-action-report-http.mjs';
import { PostgresGitHubActionMonitorRepository } from '../src/adapters/postgres/index.mjs';

const { Client } = pg;

export async function createGitHubActionMonitorServer(options = {}) {
  const env = options.env ?? process.env;
  const client = options.client ?? new Client({
    connectionString: env.GITHUB_ACTION_MONITOR_DB_URL ?? env.TRAINING_DB_URL,
    application_name: env.GITHUB_ACTION_MONITOR_DB_APP_NAME ?? env.TRAINING_DB_APP_NAME ?? 'github-action-monitor',
  });
  if (!options.client) {
    await client.connect();
  }
  const repository = options.repository ?? new PostgresGitHubActionMonitorRepository(client);
  const handler = createGitHubActionReportHttpHandler({
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    repository,
    logger: options.logger ?? console,
    fetchImpl: options.fetchImpl ?? fetch,
    allowedBranches: resolveAllowedBranches(env),
    monitorEnvironment: env.GITHUB_ACTION_MONITOR_ENVIRONMENT,
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/github/actions/report') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    const body = await readRequestBody(request);
    const fetchRequest = new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
    });
    const fetchResponse = await handler(fetchRequest);
    response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers.entries()));
    response.end(await fetchResponse.text());
  });

  server.on('close', () => {
    if (!options.client) {
      void client.end();
    }
  });

  return server;
}

function resolveAllowedBranches(env) {
  const raw = env.GITHUB_ACTION_MONITOR_ALLOWED_BRANCHES ?? env.GITHUB_ACTION_MONITOR_ALLOWED_BRANCH ?? '';
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const port = Number(process.env.PORT ?? process.env.GITHUB_ACTION_MONITOR_PORT ?? 8788);
  const server = await createGitHubActionMonitorServer();
  server.listen(port, () => {
    process.stdout.write(`GitHub Action monitor API listening on http://127.0.0.1:${port}\n`);
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
