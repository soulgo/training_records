# 飞书消息通道实施 Checklist v18

## Phase 1：文档与测试约束

- [x] 审核原方案，删除复制 Telegram 主流程、独立飞书 ingest 表、重复 image-processing/status 文件等冗余设计。
- [x] 明确本轮边界：训练图片、飞书 `/随想` 新建、`/帮助`、`/分析`；飞书随想编辑/删除/移动后续再做身份模型迁移。
- [x] 新增 RED 测试 `test/feishu-sync.test.mjs`，覆盖飞书标准化、图片分组、随想命令、inline 图片识别和共享同步管线。

## Phase 2：飞书 Adapter

- [x] 新增 `src/adapters/feishu/index.mjs`。
- [x] 新增 `src/adapters/feishu/sync-batch-logic.adapter.mjs`。
  - [x] `normalizeFeishuMessage` 保留 `sourceChannel/sourceMessageId/sourceChatId/eventId`。
  - [x] 飞书字符串 `message_id` 生成稳定安全整数代理 ID。
  - [x] 图片事件转换为 Telegram-compatible `photos[]`。
  - [x] 多图按 chat + 时间窗口分组。
  - [x] 复用 `groupTelegramUpdates` 命令解析。
- [x] 新增 `src/adapters/feishu/feishu-event.transport.mjs`。
  - [x] 从 `repository_dispatch.client_payload.feishu_updates` 读取事件。
  - [x] 兼容单条 `feishu_update`。
- [x] 新增 `src/adapters/feishu/feishu-api.mjs`。
  - [x] tenant access token 获取与缓存。
  - [x] 飞书文本消息发送。
  - [x] 飞书图片资源下载。

## Phase 3：共享同步管线适配

- [x] `src/app/use-cases/telegram-sync.use-case.mjs`
  - [x] 支持注入 `resolveDispatchUpdates`。
  - [x] 支持注入 `groupUpdates`。
  - [x] `allowedChatIds` 同时兼容数字 Telegram chat id 与字符串飞书 chat id。
  - [x] 批次结果保留 `sourceChannel`。
- [x] `src/app/use-cases/telegram-sync/image-processing.mjs`
  - [x] 支持 `sourceChannel`。
  - [x] 支持通道无关 `fetchImageFileById`。
  - [x] 飞书使用 `FEISHU_RECOGNITION_IMAGE_INPUT_MODE=inline`。
  - [x] 识别结果保留 `sourceMessageId`。
- [x] `src/adapters/postgres/incremental-write.pg.mjs`
  - [x] `persistTelegramImageBatchIncremental` 接收 `sourceChannel`，默认仍为 `telegram`。
- [x] `src/db/training/write.mjs`
  - [x] `persistNormalizedBatch` 接收并透传 `sourceChannel`。

## Phase 4：飞书同步入口与通知

- [x] 新增 `src/app/use-cases/feishu-sync.use-case.mjs`。
  - [x] 读取 `FEISHU_*` 配置。
  - [x] 将飞书 env 映射到共享同步管线所需的最小 env。
  - [x] 注入飞书事件解析、分组、图片下载、消息发送和 `sourceChannel: 'feishu'` 入库。
- [x] 新增 `tools/feishu-sync.mjs`。
- [x] 新增 `tools/feishu-sync-notify.mjs`。
- [x] 新增 `docs/部署维护/飞书通道部署.md`，覆盖飞书开放平台、GitHub、Cloudflare Worker、main/dev 差异和验收步骤。
- [x] 更新 `package.json` scripts：`sync:feishu`、`feishu:sync`。

## Phase 5：飞书随想兼容

- [x] `tools/telegram-thoughts.mjs`
  - [x] 飞书图片 artifact 文件名使用 `YYYY-MM-DD-feishu-thought-<代理ID>-N.ext`。
  - [x] 飞书 Markdown 兼容输出支持 `source_channel/source_message_id/source_chat_id`。
  - [x] Telegram 文件名和 front matter 保持不变。
- [x] `src/core/thought-modules.mjs`
  - [x] 标签支持飞书通道：`飞书`。
  - [x] 默认 Telegram 标签不变。
- [x] `src/domain/training/training-snapshot.mjs`
  - [x] 身体反馈 Markdown 读取兼容 `-feishu-thought-` 文件。

## Phase 6：Cloudflare 与 GitHub Actions

- [x] 新增 `cloudflare/feishu-sync-dispatch-worker.mjs`。
  - [x] `url_verification` challenge。
  - [x] Web Crypto HMAC-SHA256 签名验证。
  - [x] `FEISHU_VERIFICATION_TOKEN` 校验。
  - [x] 图片事件 Durable Object 缓冲。
  - [x] GitHub `repository_dispatch`，`event_type=feishu_update`。
- [x] 新增 `wrangler.feishu.toml`。
- [x] 新增 `.github/workflows/feishu-sync.yml`。
- [x] 新增 `.github/workflows/feishu-sync-dev.yml`。
- [x] 新增 `.github/workflows/deploy-cloudflare-feishu-worker.yml`，支持手动触发和 main 分支 Worker 相关文件路径触发。

## Phase 7：验证

- [x] `node --test test/feishu-sync.test.mjs` 通过。
- [x] `node --test test/telegram-sync-runner.test.mjs test/training-db-core.test.mjs` 通过。
- [x] `npm run test:fast` 或全量 `npm test` 通过。

## 外部配置待办

- [ ] 飞书开放平台创建企业自建应用。
- [ ] 开通 `im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`、`im:resource`。
- [ ] 配置 GitHub Secrets：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。
- [ ] 配置 GitHub Variables：`FEISHU_ALLOWED_CHAT_IDS`。
- [ ] 配置飞书 Cloudflare Worker Secrets：`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`、`GITHUB_TOKEN`。
- [ ] 部署 Worker 并在飞书开放平台配置事件订阅 URL。
- [ ] 部署后确认 Worker 已绑定 `FEISHU_IMAGE_BUFFER` Durable Object，并完成 SQLite migration。
