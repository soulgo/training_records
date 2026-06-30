# Action 性能与稳定性优化

> **第三轮修订（2026-06-28）**：基于真实运行日志复核，两项修订——(1) 测试 fixture 噪声主要入口是 **deploy**（site-build `run_tests:'true'`），不止 CI；(2) snapshot 泄漏范围扩大到两个 deploy workflow。带 ⚠️ 的条目为第三轮修订。

## 结论

本次二次复核不使用历史 run 的耗时和日志行数作为结论。当前可由源码与**真实运行日志**验证的性能与稳定性问题集中在：

1. ⚠️ **生产 main 分支仍把完整 dispatch payload 写入 `$GITHUB_ENV`**（dev 已修复未合并，见 05 P0-0）。
2. deploy workflow 触发后长轮询，中间缺少周期性状态日志。
3. sync、deploy、markdown-backup、CI 多处独立 `npm ci`，端到端链路重复安装依赖。
4. ⚠️ `export:markdown` 在 **backup + 两个 deploy** Action 中输出完整 `snapshot`（实测 Deploy #350 含 399 处、Deploy CF #233 含 223 处、Backup #20 含 1746 行健康明细），同时造成日志噪声和健康数据暴露。deploy 为高频泄漏。
5. DB client 分散创建，且没有慢查询日志机制。
6. ⚠️ **测试 fixture 噪声在每次 deploy 都出现**（site-build `run_tests:'true'`，实测 Deploy #350 build step 含 350 行 `primary AI recognition failed...retrying`），不止 CI。
7. AI / COS 未发现无条件重复调用；当前只存在有条件 retry / fallback / HeadObject skip 机制。

## A/B/C 复核分类

| 项目 | 结论 | 分类 |
| --- | --- | --- |
| deploy 等待缺少周期性状态 | `sync.yml` / `sync-dev.yml` 轮询 deploy run，中间只 sleep，不输出 attempt/status | A |
| 重复依赖安装 | 多个 workflow/action 均执行 `npm ci` | A |
| Markdown 导出 stdout 过量 | `export:markdown` 输出完整 payload，包含 `snapshot` | A |
| DB 无慢查询日志 | 未发现 query wrapper / threshold 机制 | A |
| DB client 分散 | pending、persist、AI call log、analysis call log 分别建 client | A |
| AI 耗时细分不足 | result 有部分 stage，summary 未聚合 provider/model/token/retry/fallback | B |
| 异常吞掉 | 存在 best-effort/fallback，但关键写库失败会 pending 或抛出 | B |
| 重复 AI / COS | 无无条件重复调用或重复上传证据 | C |

## 性能瓶颈分析

### 1. deploy workflow 等待

同步 workflow 在业务写库后触发 deploy workflow，并主动轮询：

- Main: `.github/workflows/sync.yml:570-594` 最多 30 次、每次 sleep 5s 查找 deploy run；`:602-625` 最多 90 次、每次 sleep 10s 等待完成。
- Dev: `.github/workflows/sync-dev.yml:556-580` 最多 30 次查找；`:588-611` 最多 90 次等待完成。

问题：

- 中间没有周期性状态输出。
- 轮询 GitHub API 的最后状态没有 summary。
- deploy run 查找主要按创建时间和 run-name 关联，未传 `parentRunId` / `traceId`。

建议：

1. 每 3 到 6 次轮询输出 `attempt/status/elapsedMs`。
2. deploy workflow input 带 `traceId` 和 `parentRunId`。
3. deploy workflow summary 回写 `parentRunId`、`triggeredBy`。
4. 超时时输出最后一次 GitHub API status、run URL、workflow file。

### 2. 重复依赖安装

当前维护链路包含多处独立依赖安装：

- Sync Main: `.github/workflows/sync.yml:64-66`
- Sync Dev: `.github/workflows/sync-dev.yml:58-60`
- Shared Site Build: `.github/actions/site-build/action.yml:42-45`
- Markdown Backup: `.github/workflows/markdown-backup.yml:78-80`
- CI Tests: `.github/workflows/ci-tests.yml:79-80`、`:102-103`

建议：

1. 保持跨 workflow 独立安装，避免破坏可重复性。
2. 统一使用 npm cache。
3. routine workflow 使用 `npm ci --no-audit --fund=false`，安全审计放独立 workflow。
4. 安装 step 只输出耗时和失败摘要。

### 3. Markdown 导出输出过量

部署和备份都会执行 DB -> Markdown：

- Shared Site Build: `.github/actions/site-build/action.yml:109-121`
- Markdown Backup: `.github/workflows/markdown-backup.yml:82-84`

代码事实：

- `tools/export-training-markdown.mjs:39-47` 读取 snapshot、生成 Markdown、导出随想 posts，并返回 `snapshot`。
- `tools/training-maintenance.mjs:87` 将 payload pretty JSON 输出。
- `tools/training-maintenance.mjs:672-696` 的 export 分支直接把 `exportDerivedTrainingMarkdown()` 结果放入 `result`。

建议：

1. `export:markdown` 默认只输出 compact summary。
2. 如需完整 payload，增加显式本地参数 `--debug-json`。
3. summary 增加 `dailyCount`、`thoughtExportedCount`、`removedCount`、`durationMs`、`outputPath`。

### 4. DB 连接分散与慢查询缺失

同步链路中多处分别创建 DB client：

- pending 读写：`src/db/training/pending-recognition.mjs:19`、`:149`、`:240`、`:268`
- batch persist：`src/db/training/write.mjs:67`
- recognition cache read：`src/app/use-cases/image-recognition.use-case.mjs:292`
- analysis call log：`tools/training-analysis.mjs:231`
- snapshot parallel read：`src/db/training/read-client.mjs:60-73` 默认 6 个 client

这不应立即改为连接复用，因为会影响事务边界和失败隔离。先做日志观测：

1. 每个 DB 阶段输出 duration。
2. persist 输出 transaction id、status、row count summary。
3. pending 输出 claimed/resolved/queued count。
4. 添加 slow query threshold wrapper，只记录 operation、duration、threshold，不记录 SQL 参数。

### 5. AI 初始化、调用和 fallback

代码事实：

- Telegram 同步创建 AI provider：`telegram-sync.use-case.mjs:111-113`
- 飞书同步创建共享 provider：`feishu-sync.use-case.mjs:39-41`
- recognition provider 可带 fallback：`telegram-sync.use-case.mjs:616-667`
- HTTP retry：`openai-compatible.adapter.mjs:115-145`
- response_format fallback：`image-recognition.use-case.mjs:788-821`
- provider fallback：`image-recognition.use-case.mjs:196-244`

当前无法从 Action summary 快速区分：

- 图片下载耗时还是 AI 请求耗时。
- HTTP retry 是否发生。
- response_format fallback 是否发生。
- fallback provider 是否发生。
- token 用量是多少。

建议把 `provider/model/promptVersion/schemaVersion/attemptKind/fallbackUsed/retryCount/durationMs/usage` 聚合进 batch summary。

### 6. CI fast/full test 重叠

`ci-tests.yml` 中 `test` job 总是跑 `npm run test:fast`，`full-test` job 在 schedule/workflow_dispatch 再跑 `npm test`：

- `.github/workflows/ci-tests.yml:65-87`
- `.github/workflows/ci-tests.yml:89-106`
- `package.json:7-8` 显示 `test:fast` 是 `node --test` 加 skip-pattern，属于 full test 的子集。

建议：

1. schedule/manual 只跑 full-test，或让 fast job 在 full-test 场景跳过。
2. 测试模拟 stderr 加 `[test-fixture]` 前缀。
3. 对 Node test 使用 reporter summary，失败时再展开详细日志。
4. ⚠️ **第三轮新增**：deploy workflow 的 site-build 传 `run_tests:'true'`（`deploy-pages.yml:78`、`deploy-cloudflare-pages-dev.yml:72`），导致每次部署都跑 `test:fast`，fixture 噪声进 deploy 日志。建议 deploy 的 `run_tests` 默认设为 `false`（生产部署无需每次跑测试，CI 已覆盖），或将 fixture stderr 仅在失败时展开。

## 稳定性问题分析

### 1. cache purge 与 deploy 状态边界

生产 deploy 成功后执行 Cloudflare cache purge：

- 成功 purge 时 `cat response_file`，见 `.github/workflows/deploy-pages.yml:110-113`。
- 所有 token 失败时 `exit 1`，见 `deploy-pages.yml:121-125`。
- 缺少 token 时单独 `exit 1`，见 `deploy-pages.yml:127-131`。

页面发布和缓存刷新是两个不同状态。建议 summary 区分：

- `deployStatus`
- `cachePurgeStatus`
- `cachePurgeTokenName` 或 `tokenKind`
- `lastHttpStatus`

### 2. pending replay 可观测性不足

代码支持 pending claim、append、resolve：

- claim：`pending-recognition.mjs:13-86`
- append：`pending-recognition.mjs:135-221`
- resolve：`pending-recognition.mjs:256-287`

但成功路径没有输出 pending 队列为空、claimed count 或 resolved count。

建议每次同步输出：

- `pending.claimedCount`
- `pending.resolvedCount`
- `pending.remainingCount`
- `pending.oldestAgeMinutes`
- 失败进入 pending 时输出 `nextRetryAt` 和 `attemptCount`

### 3. COS 上传稳定性

代码事实：

- 本地存储已存在文件则 `skipped`，见 `tools/telegram-thoughts.mjs:518-523`。
- Tencent COS 上传前 `HeadObject`，已存在则 `skipped`，见 `telegram-thoughts.mjs:681-686`。
- `PutObject` 最多 3 次重试，见 `telegram-thoughts.mjs:689-711`。
- 失败后再次 `HeadObject`，若对象已存在则 `skipped`，见 `telegram-thoughts.mjs:714-720`。

因此“COS 重复上传”不成立。保留的约束是：后续新增 COS 日志时，`bucket`、`pathPrefix`、`key` 只能输出摘要或 hash，不能作为重复上传问题处理。

## 优化优先级

| 优先级 | 项目 | 价值 | 风险 |
| --- | --- | --- | --- |
| P0 | `export:markdown` compact summary | 避免健康数据进入 Action 日志 | 中，需要确认无脚本依赖完整 stdout |
| P1 | 统一 action logger | 后续日志体系基础 | 低 |
| P1 | traceId 贯穿 Worker/Queue/Action/AI/DB/Deploy | 降低跨系统排障成本 | 中，需要字段贯穿 |
| P1 | 抽 sync summary 脚本 | 降低 YAML 重复和维护成本 | 低 |
| P1 | AI/DB summary 字段 | 提升排障效率 | 中，需要穿透字段 |
| P1 | deploy wait 状态日志 | 降低长等待不确定性 | 低 |
| P2 | DB slow query wrapper | 发现真实慢查询 | 中，需要避免打印 SQL 参数 |
| P2 | CI 降噪与 job 去重 | 降低日志规模和耗时 | 低 |
| P2 | dispatch payload 防回归约束 | 防止后续误打印原文 | 低 |

## 不成立问题处理

| 原问题 | 复核结论 | 处理 |
| --- | --- | --- |
| 原始 dispatch payload 已进入 Action 普通日志 | ⚠️ **第三轮回退**：原"当前 workflow 未 echo 原文"结论**错误**。实测生产 main 仍写 `SYNC_DISPATCH_PAYLOAD` 原文到 `$GITHUB_ENV`（Sync Main #112 日志可见），dev 已修复未合并 | **回退为 P0 安全阻塞项**：合并 dev 修复到 main |
| 重复 AI 调用是已验证性能浪费 | 只发现有条件 retry/fallback | 不作为已验证性能问题 |
| COS 重复上传是已验证性能浪费 | 上传前后都有存在性检查 | 不作为已验证性能问题 |
| 样本日志行数和耗时能作为结论 | 当前仓库无法从源码复算历史日志样本 | 从本文删除 |
