# Telegram Sync PostgreSQL 提速与 OpenAI 兼容 API 适配评估（V11）

本文基于 `2026-06-08` 当前仓库代码、`CHANGELOG.md`、`docs/优化重构/数据库唯一事实源与 markdown 备份_v10/数据库唯一事实源与Markdown备份方案.md`、GitHub Actions 实际日志以及相关 workflow / 脚本实现整理。V11 目标是同时优化 PostgreSQL 优先链路、Markdown 备份链路、Telegram 同步耗时，以及当前 AI 调用对 OpenAI-compatible API 的可配置适配能力。本文件给后续实现提供一份可评估的优化建议，不直接改变业务逻辑。

## 1. 结论

当前 dev 代码已经实现 v10 方案中的核心数据边界：

- Telegram 图片解析结果先写 PostgreSQL，正常成功路径写入 `ingest.*` 审计层，并增量 upsert `core.measurement`、`core.activity`、`core.meal`、`core.sleep`。
- Markdown 已从主事实源降级为数据库派生备份和人工可读备份，不再作为部署默认回灌数据库的来源。
- `markdown-backup.yml` 已通过固定 cron 唤醒，再由 GitHub Variables 控制是否执行 DB -> Markdown 导出与提交。
- Telegram Sync 已把站点构建和 Pages 发布从同步主链路拆出，repository dispatch 下先完成解析和入库，再异步触发独立部署 workflow。
- 图片识别、`/analysis` 训练分析和 Telegram AI agent 已统一走 `openai-compatible` provider，核心请求形状是 `${AI_BASE_URL}/chat/completions`。

最新 `Telegram Sync (Dev)` 日志显示，主同步链路已经从旧路径的 6-11 分钟收敛到约 40-65 秒；其中真正执行 `npm run sync:telegram` 的核心同步步骤约 21-25 秒。剩余瓶颈主要集中在 AI 图片识别、数据库持久化往返，以及独立 Pages 构建中仍存在的 archive 写库延迟。AI 层虽然已抽象为 OpenAI-compatible provider，但 GitHub Actions 里还应显式透传 provider、timeout、识别模型等配置，并把不同 OpenAI 兼容服务的请求差异纳入 V11 可用性优化。

## 2. V10 目标实现核对

| 目标 | 当前状态 | 证据 |
| --- | --- | --- |
| 图片解析先写 PostgreSQL | 已实现 | `src/db/training/write.mjs` 的 `persistNormalizedBatch()` 写入 `ingest.telegram_batch/message/recognition` 后，训练图片批次调用 `persistTelegramImageBatchIncremental()` 写入 `core.*` |
| Telegram 图片成功路径不即时重写 `训练记录.md` | 已实现 | `telegram-sync*.yml` 的 repository dispatch 路径只检测 repo 变化和 DB 内容变化；DB-only `ready + stored` 会触发异步部署，不再在 sync step 内全量导出 Markdown |
| `sync:db` 默认不执行 Markdown -> DB | 已实现 | `tools/training-maintenance.mjs` 默认 phase 为 `safe`；`tools/sync-training-core.mjs` 的 safe 只跑 `archive`、`ingest`，随后补 `thoughts`，不跑 `markdown` |
| Markdown 导入仅保留人工入口 | 已实现 | `package.json` 中 `import:markdown` / `reconcile:markdown` 显式转发到 `sync --phase markdown` |
| `export:markdown` 严格从数据库导出 | 已实现 | `markdown-backup.yml` 设置 `TRAINING_SNAPSHOT_SOURCE=database` 和 `TRAINING_SNAPSHOT_STRICT_DATABASE=true` 后执行 `npm run export:markdown` |
| 定时 DB -> Markdown 备份 | 已实现 | `.github/workflows/markdown-backup.yml` 使用 `37 19 * * *` cron，并用 `MARKDOWN_BACKUP_ENABLED`、`MARKDOWN_BACKUP_FREQUENCY`、`MARKDOWN_BACKUP_BRANCH`、`MARKDOWN_BACKUP_COMMIT` 门控 |
| 严格 DB-only 部署失败不回退旧 Markdown | 已实现 | Telegram Sync 异步 dispatch deploy workflow 时传入 `strict_database_snapshot=true`，deploy workflow 映射为 `TRAINING_SNAPSHOT_STRICT_DATABASE=true` |
| AI 调用统一 provider | 已实现基础层 | `src/ai/provider.mjs` 默认 `openai-compatible`；`src/ai/openai-compatible-provider.mjs` 调用 `${AI_BASE_URL}/chat/completions`，由 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 控制 |

## 3. Action 日志耗时观察

### 3.1 最新 Telegram Sync (Dev)

| Run | 时间 | 总耗时 | `npm run sync:telegram` | 主要阶段耗时 |
| --- | --- | ---: | ---: | --- |
| `27110018452` | 2026-06-08 00:50 UTC | 45 秒 | 21 秒 | `recognition` 10947 ms，`persist` 3741 ms，`readPendingRecognition` 1984 ms，`sleepBackfill` 1501 ms，`readOffset` 1326 ms，`markRecognitionResolved` 1287 ms |
| `27109185891` | 2026-06-08 00:16 UTC | 64 秒 | 25 秒 | `recognition` 14056 ms，`persist` 5837 ms，`markRecognitionResolved` 1561 ms，`readPendingRecognition` 1581 ms，`readOffset` 1439 ms |
| `27109177972` | 2026-06-08 00:16 UTC | 41 秒 | 22 秒 | `recognition` 11527 ms，`persist` 6078 ms，`readOffset` 1470 ms，`readPendingRecognition` 1380 ms，`markRecognitionResolved` 1378 ms |

结论：

- `recognition` 是同步主链路最大头，占核心同步耗时约一半。
- `persist` 已经比旧的构建内联路径快很多，但 3.7-6.1 秒仍有压缩空间。
- `readOffset`、`readPendingRecognition`、`markRecognitionResolved`、`sleepBackfill` 都是 1-2 秒级，单项不大，但合计会吃掉 4-6 秒。
- 最新 dev sync 只负责解析、入库、通知和异步 dispatch，站点构建已经不再阻塞 Telegram 回执。

### 3.2 旧内联构建/部署路径

| Run | 时间 | 总耗时 | 关键观察 |
| --- | --- | ---: | --- |
| `27093226444` | 2026-06-07 12:57 UTC | 约 9 分 7 秒 | `sync:telegram` 约 5 分 16 秒；随后同一个 job 内继续 build/deploy dev site，整体回执被站点构建和 Cloudflare Pages 部署拖长 |
| `27092745263` | 2026-06-07 12:36 UTC | 约 11 分 14 秒 | 同属旧路径，说明 v10 后的异步部署拆分收益明确 |

旧路径的主要问题不是单纯 AI 识别，而是 Telegram 同步、站点构建、Pages 发布串行在同一个 job 内，导致用户收到“解析完成”通知前必须等待部署。

### 3.3 最新 Deploy Cloudflare Pages (Dev)

| Run | 时间 | 总耗时 | 关键观察 |
| --- | --- | ---: | --- |
| `27110033979` | 2026-06-08 00:51 UTC | 约 4 分 16 秒 | `Build dev site` 约 3 分 48 秒；`generate-training-data` 打印完三个 generated 文件后，到 `build:site` 开始之间存在接近 3 分钟空窗 |

该空窗来自 `tools/generate-training-data.mjs` 在生成 `source/_data/training.json`、`source/_data/dashboardView.json`、`训练数据解析.md` 后继续执行 `persistArchive()`。当前 archive 写入会按历史 daily、measurement、activity、meal、sleep 逐条 upsert 远程 PostgreSQL，和数据库唯一事实源模式下的严格构建目标存在职责重叠，也造成独立部署耗时明显偏高。

## 4. V11 优化优先级

| 优先级 | 优化项 | 预期收益 | 风险 |
| --- | --- | --- | --- |
| P0 | 给构建期 archive 写入加门控，deploy 固定跳过 | dev/main 严格 DB 部署减少约 2-3 分钟；构建职责更纯粹 | 需要确认 archive 历史快照仍由维护命令或显式流程保留 |
| P0 | GitHub Actions 补齐 OpenAI-compatible 配置透传 | 可在 GitHub Settings 中切换 OpenAI 官方、第三方网关或本地兼容服务，提高部署可用性 | 需要避免把非 OpenAI 协议 provider 混入本次范围 |
| P0 | archive 写入 source hash 早停与批量 upsert | 手工 archive/Markdown 源构建仍可保留审计，但避免全量逐条远程往返 | 批量 SQL 需要覆盖 measurement/activity/meal/sleep 字段完整性 |
| P1 | OpenAI-compatible provider 增强兼容差异处理 | 对不完整支持 `response_format`、超时或模型能力差异的兼容服务更稳 | 可选 header / endpoint override 要保持默认行为不变 |
| P1 | Telegram 同步复用单个 PG client | 减少 `readOffset`、pending、persist、resolved、sleep backfill 的连接开销，预计节省 2-5 秒 | 需要仔细处理事务边界和失败降级 |
| P1 | `persist` 后 training day 汇总改为单 SQL/CTE | 减少当前写入后多次 select + upsert 往返，压缩 3.7-6.1 秒 persist | SQL 可读性会变复杂，需要测试保护 |
| P1 | sleep backfill 条件化 | 无 sleep 批次或无待修复 ingest 时跳过 1-1.5 秒级 DB 操作 | 必须避免漏修旧的 archive-only sleep 数据 |
| P2 | recognition cache 默认在 dev/main 启用 | 重放或重复图片可跳过 AI 请求，大幅减少重复识别耗时 | 首次识别无收益；prompt/model/schema 变更时必须自动 miss |
| P2 | inline 图片选择足够清晰的最小 photo size | 降低下载、base64 编码和 AI 传输体积，改善 `recognition` p50/p95 | 图片过小会损害 OCR，需设置像素下限和回退 |

## 5. 建议实现方案

### 5.1 构建期 archive 写入门控

新增环境变量 `TRAINING_BUILD_ARCHIVE_WRITE=auto|true|false`：

| 值 | 行为 |
| --- | --- |
| `false` | 构建只读数据库并生成静态数据，不执行 `persistArchive()` |
| `true` | 保持现有行为，生成数据后写入 archive |
| `auto` | 仅 Markdown 源构建时允许 archive 写入；数据库严格模式下跳过 |

建议默认值为 `auto`。`deploy-pages.yml` 和 `deploy-cloudflare-pages-dev.yml` 固定设置 `TRAINING_BUILD_ARCHIVE_WRITE=false`，使部署构建不再承担 archive 写库职责。需要 archive 审计时，通过维护命令或单独 workflow 显式执行。

实现点：

- 在 `tools/generate-training-data.mjs` 中生成输出文件后，根据 `TRAINING_BUILD_ARCHIVE_WRITE`、`snapshotSource`、`TRAINING_SNAPSHOT_STRICT_DATABASE` 决定是否调用 `persistArchive()`。
- 跳过时输出一行清晰日志，例如 `[training-db-archive] skipped by TRAINING_BUILD_ARCHIVE_WRITE=false`。
- 测试覆盖 `database + strict + false/auto` 均不写 archive，`markdown + auto` 仍保持原行为。

### 5.2 archive 写入早停与批量化

如果保留 archive 写入，建议先查 `archive.training_parse_snapshot` 中相同 `source_hash` 的 `last_seen_at`。当 payload hash 完全相同且只需要运行留痕时：

- 只更新 `archive.training_parse_snapshot.last_seen_at`。
- 插入一条 `archive.training_parse_run`。
- 跳过 `archive.training_day/activity/measurement/meal/sleep` 逐条 upsert。

当 source hash 变化时，再把逐条 upsert 改为批量 `unnest`：

- day 一条批量 insert。
- measurement/activity/meal/sleep 各一条批量 insert。
- 与 `src/db/training/core-row-writer.mjs` 现有批量写入风格保持一致。

### 5.3 Telegram 同步 DB client 复用

当前同步路径中这些阶段都可能独立连接 PostgreSQL：

- `readOffset`
- `readPendingRecognition`
- `persist`
- `markRecognitionResolved`
- `sleepBackfill`

建议为 `runTelegramSync()` 引入 run-scoped DB context：

- repository dispatch 下创建一个共享 `pg.Client`。
- 将该 client 注入 `getLastProcessedTelegramUpdateId`、pending recognition store、`persistNormalizedBatch`、resolved 标记、sleep backfill。
- 如果共享 client 初始化失败，沿用现有降级和 pending 机制，不影响通知。

验收目标是最新 `timingsMs` 中 DB 小阶段合计明显下降，并且失败分类仍能正确归入 database / system。

### 5.4 持久化汇总单 SQL 化

`src/db/training/incremental-write.mjs` 当前 `refreshCoreTrainingDaySummary()` 会在写完子表后读取 activity、meal、training_day，再 upsert `core.training_day`。建议改为一条 CTE：

- `activity_summary` 从 `core.activity` 聚合。
- `meal_summary` 从 `core.meal` 聚合。
- `existing_day` 保留未由本批覆盖的 `workout_duration_minutes`、`active_hours`、`nutrition_details_json`。
- 最终 `insert ... on conflict do update` 写回 day summary。

这样可以把 3 次 select + 1 次 upsert 合并为 1 次 round trip，同时保持“本批没有的模块不覆盖历史模块”的语义。

### 5.5 sleep backfill 条件化

`sleepBackfill` 只在这些场景运行：

- 当前 batch 含 `sleep` payload。
- pending replay 结果含 sleep。
- DB 中存在未修复的 sleep ingest batch。
- 手工维护命令显式要求 ingest phase。

建议新增一个轻量判断函数，例如 `shouldRunSleepBackfill(batchResults, pendingRecognitionResults, env)`。在无 sleep 的普通体脂/运动/饮食批次里跳过该阶段，并在 `timingsMs` 里记录 `sleepBackfillSkipped` 或 `sleepBackfill: 0`。

### 5.6 recognition cache 与图片尺寸

当前代码已具备 recognition cache 能力，但默认是 opt-in。建议：

- dev/main workflow 设置 `TELEGRAM_RECOGNITION_CACHE_ENABLED=true`。
- cache key 继续包含 `file_unique_id`、prompt version、schema version、model。
- 对 pending replay 和重复 dispatch 优先命中 cache。

图片输入方面，当前 GitHub Actions 默认 `TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE=inline`。建议在 inline 下载时选择满足 OCR 的最小 photo size：

- 优先选择宽高均不低于约 1000px 或最大边不低于约 1280px 的最小版本。
- 如果没有合格版本，使用当前最大版本。
- 对 sleep/饮食这类文字密集截图，可保守使用更高下限。

该优化应先在 dev 观察 `recognition` p50/p95 和识别失败率，再决定是否推广到 main。

### 5.7 OpenAI 兼容 API 适配

当前系统已经不是硬编码 OpenAI 官方 SDK，而是通过 `src/ai/provider.mjs` 创建默认 `openai-compatible` provider。该 provider 从 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 读取配置，并向 `${AI_BASE_URL}/chat/completions` 发送 OpenAI Chat Completions 形状请求。图片识别仍使用 `messages + image_url`，训练分析继续使用纯文本 `messages`，两者共享同一 provider。

V11 建议把该能力从“代码里可用”推进到“GitHub Settings 中可替换服务”：

- `.github/workflows/telegram-sync.yml` 和 `.github/workflows/telegram-sync-dev.yml` 显式透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_CACHE_ENABLED`，其中 `AI_PROVIDER` 默认保持 `openai-compatible`。
- `AI_API_KEY` 继续作为 GitHub Secret；`AI_BASE_URL`、`AI_MODEL`、`TELEGRAM_RECOGNITION_MODEL`、`AI_TIMEOUT_MS`、`AI_CONCURRENCY` 作为 GitHub Variables。
- 保留默认 `authorization: Bearer ${AI_API_KEY}`，避免破坏 OpenAI 官方和绝大多数兼容网关。
- 继续依赖识别服务已有的 `json_schema -> json_object -> 无 response_format` 降级路径，兼容不完整支持 Structured Outputs 的服务。
- 后续如确有需要，再增加 `AI_HEADERS_JSON`、`AI_CHAT_COMPLETIONS_PATH` 或 `AI_ENDPOINT_URL` 这类可选配置；默认情况下仍只拼接 `${AI_BASE_URL}/chat/completions`。
- 本轮 V11 不引入 Claude、Gemini 等非 OpenAI 协议 provider，也不要求业务调用点知道具体模型厂商。

GitHub Settings 配置建议：

| 配置项 | 类型 | 建议值/说明 |
| --- | --- | --- |
| `AI_API_KEY` | Secret | 当前 AI 平台 API key，不写入仓库 |
| `AI_PROVIDER` | Variable | `openai-compatible`，未配置时仍应回退默认值 |
| `AI_BASE_URL` | Variable | OpenAI-compatible base URL，例如 `https://api.openai.com/v1` |
| `AI_MODEL` | Variable | `/analysis` 和默认图片识别模型 |
| `TELEGRAM_RECOGNITION_MODEL` | Variable | 可选，仅覆盖 Telegram 图片识别模型；未配置时回退 `AI_MODEL` |
| `AI_TIMEOUT_MS` | Variable | 可选，避免兼容服务长时间无响应拖慢同步 |
| `AI_CONCURRENCY` | Variable | 图片识别并发，当前默认 3 |

示例配置：

| 场景 | `AI_BASE_URL` | `AI_MODEL` | 备注 |
| --- | --- | --- | --- |
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4.1` 或当前可用视觉模型 | 适合作为默认生产配置 |
| 第三方 OpenAI-compatible 网关 | `https://example-gateway.com/v1` | 网关暴露的模型名 | 需要确认支持 chat completions 和图片 `image_url` |
| 本地兼容服务 | `http://127.0.0.1:11434/v1` 或内网 URL | 本地服务暴露的模型名 | GitHub Actions 需能访问该地址，通常更适合自托管 runner |

验收目标：

- `/analysis` 与 Telegram 图片识别都只依赖同一组 OpenAI-compatible 配置，不在调用点分叉厂商逻辑。
- 未配置 `AI_PROVIDER` 时继续走 `openai-compatible`，配置为其他值时仍快速失败并给出明确错误。
- 对 `response_format` 支持不完整的兼容服务，图片识别能按既有降级链路重试。
- dev/main workflow 日志能看出使用的模型、超时和识别模型覆盖，不泄露 `AI_API_KEY`。

## 6. 验收建议

实现后建议至少观察三类日志：

1. Telegram Sync repository dispatch：
   - `recognition` 仍输出独立耗时。
   - `persist` 降到稳定低于 3 秒，或至少比当前 3.7-6.1 秒明显下降。
   - 无 sleep 批次不再固定出现 1 秒以上 `sleepBackfill`。
   - Telegram 回执仍在入库完成后发送，不等待 Pages deploy。

2. Deploy Cloudflare Pages (Dev)：
   - `generate-training-data` 打印 generated 文件后，应快速进入 `build:site`。
   - 严格 DB 模式不回退 Markdown。
   - 构建日志明确显示 archive 写入已按环境变量跳过。

3. Markdown Backup：
   - 手动触发 `markdown-backup.yml` 仍能在 `TRAINING_SNAPSHOT_SOURCE=database`、`TRAINING_SNAPSHOT_STRICT_DATABASE=true` 下导出 `训练记录.md`。
   - 未启用 `MARKDOWN_BACKUP_ENABLED=true` 时，定时 cron 仍只写 summary，不提交备份。

4. OpenAI-compatible API：
   - GitHub Settings 只修改 `AI_BASE_URL`、`AI_MODEL`、`TELEGRAM_RECOGNITION_MODEL`、`AI_TIMEOUT_MS` 时，无需改代码即可切换兼容服务。
   - `/analysis` 和 Telegram 图片识别都通过 `src/ai/provider.mjs` 的同一 provider 发起请求。
   - 兼容服务不支持 `json_schema` 时，识别服务能退到 `json_object` 或无 `response_format` 请求。

测试建议：

- `npm run test:fast`
- `test/ai-provider.test.mjs` 覆盖 provider 默认值、base URL 修剪、超时和请求形状。
- `test/github-workflows.test.mjs` 增加 deploy workflow 设置 `TRAINING_BUILD_ARCHIVE_WRITE=false` 的断言。
- `test/github-workflows.test.mjs` 增加 `telegram-sync*.yml` 透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_CACHE_ENABLED` 的断言。
- `test/training-analysis.test.mjs` 覆盖 `/analysis` 继续通过 OpenAI-compatible provider 请求。
- `test/training-db-archive.test.mjs` 或对应 generate-data 测试增加 archive write gate 覆盖。
- `test/telegram-sync-runner.test.mjs` 覆盖无 sleep 批次跳过 sleep backfill。
- `test/telegram-sync-runner.test.mjs` 覆盖 Telegram 图片识别使用 `TELEGRAM_RECOGNITION_MODEL` 覆盖 `AI_MODEL`，并复用 provider 配置。
- `test/training-db-core.test.mjs` 覆盖单 SQL/CTE 汇总不覆盖未出现模块。

## 7. 风险与回滚

- 构建期 archive 写入门控风险最低，且收益最大；如果后续发现 archive 审计缺口，可把 workflow 变量临时改回 `TRAINING_BUILD_ARCHIVE_WRITE=true` 或单独跑维护命令补齐。
- AI 兼容性改造必须保持 `openai-compatible` 默认路径不变；如果某个第三方网关失败，回滚方式是把 GitHub Variables 改回 OpenAI 官方或上一组可用 `AI_BASE_URL` / `AI_MODEL`。
- 不应在 V11 内混入非 OpenAI 协议模型适配；否则会扩大测试矩阵，并让 Telegram 图片识别的 `messages + image_url` 语义变得不可控。
- DB client 复用要避免把多个阶段强行放进同一个大事务；建议只共享连接，事务仍由持久化函数自己控制。
- recognition 图片尺寸优化必须以识别准确率为硬指标，不应只追求传输变小。
- Markdown 仍不得重新成为部署自动回灌数据库的默认来源；所有优化都必须保持 PostgreSQL `core.*` 为唯一事实源。
