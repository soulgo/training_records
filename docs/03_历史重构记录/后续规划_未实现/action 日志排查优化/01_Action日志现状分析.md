# Action 日志现状分析

> 二次复核口径：只保留当前源码、workflow 和 SQL schema 可验证的事实；历史 Action 样本日志中的行数、耗时、run id 不作为结论依据。
>
> **第三轮修订（2026-06-28）**：引入分支基线。前两轮以 `dev` 工作树为"当前源码"，但生产 `main` 分支与 `dev` 已分叉。凡"当前状态"判断一律以**生产 `main`** 为准；dev 已修复但未合并到 main 的项，标注为"dev 已修复 / main 未修复"。本文件中带 ⚠️ 的条目为第三轮基于真实运行日志的修订。

## 分支基线

| 项 | main（生产） | dev（工作树） |
| --- | --- | --- |
| dispatch payload 写 `$GITHUB_ENV` | ⚠️ **仍在泄漏**，`sync.yml:89-91`、`sync-dev.yml:83-85` | 已修复（`026ef49`+`2d45b74`，未合并 main） |
| 其余链路 | 与 dev 基本一致 | — |

## 复核范围

本次重新阅读并核对了以下实现：

- Workflow：`.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml`、`.github/actions/site-build/action.yml`、`.github/workflows/deploy-pages.yml`、`.github/workflows/deploy-cloudflare-pages-dev.yml`、`.github/workflows/markdown-backup.yml`、`.github/workflows/ci-tests.yml`、`.github/workflows/refresh-telegram-webhook.yml`
- Worker / Queue：`cloudflare/sync-dispatch-worker.mjs`、`cloudflare/telegram-sync-dispatch-worker.mjs`、`cloudflare/feishu-sync-dispatch-worker.mjs`、`cloudflare/sync-dispatch-queue.mjs`
- 同步主链路：`src/app/use-cases/telegram-sync.use-case.mjs`、`src/app/use-cases/feishu-sync.use-case.mjs`、`src/app/use-cases/telegram-sync/image-processing.mjs`、`src/app/use-cases/telegram-sync/status.mjs`
- AI：`src/app/use-cases/image-recognition.use-case.mjs`、`src/adapters/ai/openai-compatible.adapter.mjs`、`tools/training-analysis.mjs`、`tools/training-analysis-request.mjs`
- DB：`src/db/training/write.mjs`、`src/db/training/pending-recognition.mjs`、`src/db/training/read-client.mjs`、`src/adapters/postgres/telegram-batch-repository.pg.mjs`、`src/adapters/postgres/incremental-write.pg.mjs`
- Telegram / 飞书 / COS / Markdown：`src/adapters/telegram/*`、`src/adapters/feishu/*`、`tools/telegram-thoughts.mjs`、`tools/export-training-markdown.mjs`、`tools/training-maintenance.mjs`

## 总体结论

当前 Action 日志体系处于“能判断同步批次结果，但没有统一全链路观测模型”的状态。

| 分类 | 结论 | 源码依据 |
| --- | --- | --- |
| A 真实成立 | 没有独立 `traceId` 字段贯穿 Worker、Queue、Action、AI、DB、Deploy | `rg "traceId|trace_id"` 在源码无命中；`sync-dispatch-queue.mjs:451-485` 只生成并传递 `queue_task_id` |
| A 真实成立 | Action summary 能展示批次级状态、pending、图片计数、AI attempt kind 和整体阶段耗时 | `sync.yml:335-388`、`sync-dev.yml:321-374`；状态来自 `status.mjs:65-107` |
| A 真实成立 | Markdown 导出会把完整 `snapshot` 进入 stdout，deploy / backup 调用时会进入 Action 日志 | `export-training-markdown.mjs:47-51` 返回 `snapshot`；`training-maintenance.mjs:87` pretty JSON 输出；`site-build/action.yml:109-121`、`markdown-backup.yml:82-84` 调用 |
| A 真实成立 | DB 没有通用慢查询日志或 SQL duration threshold 机制 | DB 调用直接 `client.query(...)`；仅 `config.mjs:7` 配置连接 timeout |
| B 部分成立 | AI 调用能记录 `promptVersion` 和 token usage 字段，但不记录 prompt 全文，Action summary 也不展示 token | `image-recognition.use-case.mjs:146-155`、`telegram-batch-repository.pg.mjs:164-327`、`pending-recognition.mjs:402-442`；summary 仅输出 `recognitionAttemptKinds` |
| B 部分成立 | 原始 dispatch payload 会作为 workflow input 和临时 event 文件传递，但当前 workflow 没有 echo 原文或写入 `$GITHUB_ENV` | `sync.yml:68-97`、`sync-dev.yml:62-90` 只写 `SYNC_DISPATCH_EVENT_PATH`；`sync-dispatch-queue.mjs:470-485` 构造 input |
| ⚠️ **第三轮修正：main 分支真实泄漏** | **生产 main 仍把完整 `SYNC_DISPATCH_PAYLOAD`（含 `file_id`/`from.id`/`username`/`chat.id`）写入 `$GITHUB_ENV`，并在后续 step env 段重复打印** | `git show main:.github/workflows/sync.yml:89-91`、`sync-dev.yml:83-85`；实测 Sync Main #112 日志第 229/605/697/828 行。dev 已修复（`026ef49`），**未合并 main** |
| B 部分成立 | 异常处理存在 best-effort / fallback 分支，但不能概括为“异常被吞掉” | DB 写入失败会 pending replay 或抛出；AI call log、sleep backfill、诊断日志失败为非阻塞 |
| C 不成立 | 未发现同一批次无条件重复调用 AI 或重复上传 COS 的代码证据 | AI 重试/fallback 有条件触发；COS 上传前 `HeadObject`，已存在则 `skipped`，见 `telegram-thoughts.mjs:681-720` |

## 链路事实

| 环节 | 当前源码事实 | 分类 |
| --- | --- | --- |
| Worker 统一入口 | `sync-dispatch-worker.mjs:28-52` 按 Telegram / 飞书分发；`logResponseIfNeeded()` 只记录 5xx | A |
| Telegram webhook | `telegram-sync-dispatch-worker.mjs:114-233` 校验 secret、处理 help、album buffer 或 dispatch；成功响应包含 `queued` / `dispatched`，正常路径无统一 accepted 日志 | A |
| 飞书 webhook | `feishu-sync-dispatch-worker.mjs:121-247` 校验 token、签名、加密 envelope；`logFeishuEventMetadata()` 记录 `event_id/chat_id/message_id/message_type` | A |
| Queue task | `sync-dispatch-queue.mjs:451-459` 用 channel、sortKey、eventType、payload hash 生成 task id；`:470-485` 放入 workflow input | A |
| Workflow payload | `sync.yml:78-97`、`sync-dev.yml:72-90` 从 `dispatch_payload` 生成 `$RUNNER_TEMP/queued-dispatch-event.json`，只把路径写入 `$GITHUB_ENV` | B |
| 同步入口 | `telegram-sync.use-case.mjs:95-552` 是统一 `runMessageSync()`；飞书在 `feishu-sync.use-case.mjs:90-126` 复用该链路 | A |
| 同步结果 | `telegram-sync.use-case.mjs:525-550` 返回 result 并写 result file；`tools/telegram-sync.mjs:22-25`、`feishu-sync.use-case.mjs:29-32` 输出 pretty JSON report | A |
| Action summary | `sync.yml:286-498` 与 `sync-dev.yml:272-484` 生成 Telegram / 飞书 summary；不展示 provider/model/token/DB row counts | A |

## 当前日志覆盖

### 已覆盖

| 能力 | 代码依据 | 说明 |
| --- | --- | --- |
| 批次状态 | `status.mjs:65-107` | report 包含 `taskStatus`、`persistenceStatus`、`failureDisposition`、pending、图片计数、`recognitionAttemptKinds` |
| 同步阶段耗时 | `telegram-sync.use-case.mjs:555-604` | `measureSyncStage()` 累计 `timingsMs`，并写 `[telegram-sync] timings ...` |
| 图片内部阶段 | `image-processing.mjs:227-280` | 记录 `image_download/cache_read/ai_schema/db_persist` 的 status 和 duration，进入 result JSON |
| AI retry / fallback 文本 | `openai-compatible.adapter.mjs:115-145`、`image-recognition.use-case.mjs:196-244` | retry 和 fallback 以 stderr plain text 输出 |
| DB rollback 失败 | `write.mjs:137-148` | 只有 rollback 失败时输出 `[training-db] rollback failed...` |
| COS 上传统计 | `telegram-thoughts.mjs:78-92`、`sync.yml:362-383` | summary 展示 provider、bucket、pathPrefix、uploaded/skipped/failed、耗时和 host |
| Deploy 最终结果 | `sync.yml:521-629`、`sync-dev.yml:507-615` | 找到 deploy run 后输出等待文案，完成后写 summary |

### 缺口

| 缺口 | 代码依据 | 分类 |
| --- | --- | --- |
| 无统一 `traceId` | 源码无 `traceId`；`queue_task_id` 只进入 run-name/input | A |
| AI provider/model/token 不在 Action summary | 识别结果含 `model/aiUsage/promptVersion`，但 summary 只打印 `aiAttemptKinds` | A |
| DB row counts / transaction id 不在返回和 summary | `persistNormalizedBatch()` 返回 `status/batchId/archivedDate`，见 `write.mjs:126-136` | A |
| 无慢查询日志 | DB 直接 `client.query(...)`；未发现 slow threshold wrapper | A |
| Worker 正常路径日志不统一 | 统一入口只记录 5xx；飞书正常路径有 `[feishu-webhook]`，Telegram 正常 dispatch 无同级日志 | A |

## 安全与隐私

| 项目 | 当前真实状态 | 分类 |
| --- | --- | --- |
| Secret / token / DB URL | workflow 使用 GitHub secrets；源码未主动打印 `AI_API_KEY`、`TRAINING_DB_URL`、COS secret | A |
| 原始 dispatch payload | payload 作为 input 和临时 event 文件存在；⚠️ **第三轮修正：生产 main 仍把原文 `SYNC_DISPATCH_PAYLOAD` 写入 `$GITHUB_ENV` 并在后续 step env 段重复打印**（dev 已修复未合并）。原 B 结论仅在 dev 成立 | B（dev）/ ⚠️ A（main） |
| Markdown 健康明细 | `export:markdown` stdout 包含完整 `snapshot`，会包含健康派生数据 | A |
| file_id / image_key | inline image 失败摘要会拼接 `file_id` / `image_key`，见 `image-processing.mjs:702-736` | A |
| chat_id / sourceId | 飞书 Worker 记录 `chat_id/message_id`；Feishu summary 展示 `sourceId/chatIds` | A |
| COS bucket/pathPrefix/key | summary 明文展示 bucket/pathPrefix；COS 失败日志包含 object key | A |
| Prompt 全文 | AI 请求会发送 prompt；当前 Action/DB 日志不记录 prompt 全文，只记录 `promptVersion` | A |

## 异常处理

| 分支 | 当前行为 | 分类 |
| --- | --- | --- |
| AI HTTP retry | retry 写 stderr；最终失败抛出或进入 fallback | A |
| AI strict JSON retry | invalid content 后尝试 strict JSON retry；retry 内部失败返回 `{ ok:false }`，原错误继续处理 | B |
| DB persist 失败 | 非 user_input 进入 pending replay 并写 stderr；user_input 标记 manual_intervention | A |
| sleep backfill 失败 | 写 stderr 但不阻断主同步 | B |
| AI call log 写入失败 | best-effort，写 stderr 后不阻断同步 | B |
| Worker diagnostic logging | 多处 catch 只保护日志，不影响 webhook / queue 恢复 | B |
| event file 读取失败 | `readGithubEventFile()` catch 后返回 null，日志上无法区分“文件不可读”和“没有 event 数据” | B |

## 性能与稳定性

| 项目 | 当前源码事实 | 分类 |
| --- | --- | --- |
| deploy 等待静默 | sync workflow 先 30 次查找 run，再 90 次等待完成；循环中没有周期性状态输出 | A |
| 重复依赖安装 | sync、deploy shared action、markdown-backup、CI 均执行 `npm ci` | A |
| Markdown 导出过量 stdout | deploy 和 backup 都调用 `npm run export:markdown`，该命令输出完整 payload | A |
| DB 连接分散 | pending read/append/resolve、AI call log、persist、analysis call log 分别创建 client | A |
| 快照并行读 | `read-client.mjs:60-73` 默认开 6 个 client 并行读，失败后写 stderr 并退回单 client | A |
| CI fast/full 重叠 | `ci-tests.yml:65-87` 总跑 `test:fast`；schedule/manual 还跑 `npm test` | A |
| 重复 AI / COS | 当前未发现无条件重复调用；AI retry/fallback 与 COS retry/headObject 均有条件 | C |

## 重点问题复核结果

| 检查项 | 当前真实状态 | 分类 |
| --- | --- | --- |
| TraceId 是否真实贯穿全链路 | 否。只有 `queue_task_id`、`batchId/taskId`、`aiCallId` 等局部关联键 | A |
| Action 是否具备完整生命周期日志 | 部分具备。workflow step、summary、timings 存在；缺统一 `started/completed` 结构化日志 | B |
| AI 调用日志是否真实记录 token / prompt | token usage 有字段；prompt 全文不记录，只有 `promptVersion` | B |
| DB 是否存在慢查询日志机制 | 否。没有 slow query threshold wrapper | A |
| 是否存在日志重复打印 | 存在字段级重复：timings 同时进入 stdout report、stderr timing log、step summary；summary 逻辑在 main/dev、Telegram/Feishu 重复 | B |
| 是否存在异常吞掉 | 存在非阻塞 best-effort / fallback 分支；关键 DB 写入失败不是静默吞掉 | B |
| 是否存在日志污染 | 是。Markdown full snapshot、file_id/image_key、chatIds/sourceId、COS bucket/pathPrefix/key 均有源码依据 | A |
| 是否存在性能浪费 | 有可验证的重复 npm ci、deploy wait、DB 多 client；重复 AI/COS 未成立 | B |
| 是否存在日志等级错误 | 没有统一 level 体系；存在 stderr、plain text、GitHub annotation、Worker prefix 混用，不能按正式等级错误下结论 | B |
