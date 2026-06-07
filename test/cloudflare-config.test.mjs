import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootDir = new URL('../', import.meta.url);

test('wrangler config binds Telegram album Durable Object without storing secrets', async () => {
  const config = await readFile(new URL('wrangler.toml', rootDir), 'utf8');

  assert.match(config, /^name\s*=\s*"telegram-sync-dispatch"/m);
  assert.match(config, /^main\s*=\s*"cloudflare\/telegram-sync-dispatch-worker\.mjs"/m);
  assert.match(config, /^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
  assert.doesNotMatch(config, /^pages_build_output_dir\s*=/m);
  assert.match(config, /name\s*=\s*"TELEGRAM_ALBUM_BUFFER"/);
  assert.match(config, /class_name\s*=\s*"TelegramAlbumBuffer"/);
  assert.match(config, /new_sqlite_classes\s*=\s*\["TelegramAlbumBuffer"\]/);
  assert.doesNotMatch(config, /GITHUB_OWNER/);
  assert.doesNotMatch(config, /GITHUB_REPO/);
  assert.doesNotMatch(config, /GITHUB_TOKEN|TELEGRAM_SECRET_TOKEN/);
});
