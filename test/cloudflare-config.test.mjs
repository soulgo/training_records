import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootDir = new URL('../', import.meta.url);

test('wrangler main config reuses the Feishu worker as the unified production entry without storing secrets', async () => {
  const config = await readFile(new URL('wrangler.toml', rootDir), 'utf8');

  assert.match(config, /^name\s*=\s*"feishu-sync-dispatch"/m);
  assert.match(config, /^main\s*=\s*"cloudflare\/sync-dispatch-worker\.mjs"/m);
  assert.match(config, /^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
  assert.match(config, /^workers_dev\s*=\s*true/m);
  assert.match(config, /pattern\s*=\s*"feishu\.soulgo\.chat"/);
  assert.match(config, /custom_domain\s*=\s*true/);
  assert.match(config, /\[observability\]\s*\nenabled\s*=\s*true/);
  assert.match(config, /\[observability\.logs\]\s*\ninvocation_logs\s*=\s*true\s*\nhead_sampling_rate\s*=\s*1/);
  assert.doesNotMatch(config, /^pages_build_output_dir\s*=/m);
  assert.match(config, /GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM\s*=\s*"telegram_update"/);
  assert.match(config, /GITHUB_DISPATCH_EVENT_TYPE_FEISHU\s*=\s*"feishu_update"/);
  assert.match(config, /GITHUB_SYNC_REF\s*=\s*"main"/);
  assert.match(config, /name\s*=\s*"TELEGRAM_ALBUM_BUFFER"/);
  assert.match(config, /class_name\s*=\s*"TelegramAlbumBuffer"/);
  assert.match(config, /name\s*=\s*"FEISHU_IMAGE_BUFFER"/);
  assert.match(config, /class_name\s*=\s*"FeishuImageBuffer"/);
  assert.match(config, /GITHUB_SYNC_WORKFLOW_FILE\s*=\s*"sync\.yml"/);
  assert.match(config, /name\s*=\s*"SYNC_DISPATCH_QUEUE"/);
  assert.match(config, /class_name\s*=\s*"SyncDispatchQueue"/);
  assert.match(config, /tag\s*=\s*"v1"\s*\nnew_sqlite_classes\s*=\s*\["FeishuImageBuffer"\]/);
  assert.match(config, /tag\s*=\s*"v2"\s*\nnew_sqlite_classes\s*=\s*\["TelegramAlbumBuffer"\]/);
  assert.match(config, /tag\s*=\s*"v3"\s*\nnew_sqlite_classes\s*=\s*\["SyncDispatchQueue"\]/);
  assert.doesNotMatch(config, /GITHUB_OWNER/);
  assert.doesNotMatch(config, /GITHUB_REPO/);
  assert.doesNotMatch(config, /GITHUB_TOKEN|TELEGRAM_SECRET_TOKEN|TELEGRAM_BOT_TOKEN|FEISHU_APP_SECRET|FEISHU_ENCRYPT_KEY|FEISHU_VERIFICATION_TOKEN/);
});

test('wrangler Feishu config has been removed after main worker consolidation', async () => {
  await assert.rejects(
    readFile(new URL('wrangler.feishu.toml', rootDir), 'utf8'),
    /ENOENT/,
  );
});

test('wrangler unified dev config routes Telegram and Feishu to dev workflows without storing secrets', async () => {
  const config = await readFile(new URL('wrangler.dev.toml', rootDir), 'utf8');

  assert.match(config, /^name\s*=\s*"sync-dispatch-dev"/m);
  assert.match(config, /^main\s*=\s*"cloudflare\/sync-dispatch-worker\.mjs"/m);
  assert.match(config, /^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
  assert.match(config, /^workers_dev\s*=\s*true/m);
  assert.match(config, /pattern\s*=\s*"feishu-dev\.soulgo\.chat"/);
  assert.match(config, /custom_domain\s*=\s*true/);
  assert.match(config, /\[observability\]\s*\nenabled\s*=\s*true/);
  assert.match(config, /\[observability\.logs\]\s*\ninvocation_logs\s*=\s*true\s*\nhead_sampling_rate\s*=\s*1/);
  assert.match(config, /GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM\s*=\s*"telegram_update_dev"/);
  assert.match(config, /GITHUB_DISPATCH_EVENT_TYPE_FEISHU\s*=\s*"feishu_update_dev"/);
  assert.match(config, /GITHUB_SYNC_REF\s*=\s*"dev"/);
  assert.match(config, /name\s*=\s*"TELEGRAM_ALBUM_BUFFER"/);
  assert.match(config, /class_name\s*=\s*"TelegramAlbumBuffer"/);
  assert.match(config, /name\s*=\s*"FEISHU_IMAGE_BUFFER"/);
  assert.match(config, /class_name\s*=\s*"FeishuImageBuffer"/);
  assert.match(config, /GITHUB_SYNC_WORKFLOW_FILE\s*=\s*"sync-dev\.yml"/);
  assert.match(config, /name\s*=\s*"SYNC_DISPATCH_QUEUE"/);
  assert.match(config, /class_name\s*=\s*"SyncDispatchQueue"/);
  assert.match(config, /tag\s*=\s*"v1"\s*\nnew_sqlite_classes\s*=\s*\["TelegramAlbumBuffer",\s*"FeishuImageBuffer"\]/);
  assert.match(config, /tag\s*=\s*"v2"\s*\nnew_sqlite_classes\s*=\s*\["SyncDispatchQueue"\]/);
  assert.doesNotMatch(config, /tag\s*=\s*"v1"\s*\nnew_sqlite_classes\s*=\s*\[[^\]]*"SyncDispatchQueue"/);
  assert.doesNotMatch(config, /GITHUB_OWNER/);
  assert.doesNotMatch(config, /GITHUB_REPO/);
  assert.doesNotMatch(config, /GITHUB_TOKEN|TELEGRAM_SECRET_TOKEN|TELEGRAM_BOT_TOKEN|FEISHU_APP_SECRET|FEISHU_ENCRYPT_KEY|FEISHU_VERIFICATION_TOKEN/);
});
