# 重构核对 Checklist（编码时逐条勾选）

配套文档：`重构方案-低风险.md`、`重构方案-中风险.md`、`重构方案-高风险.md`。
本文件供实际写代码时逐项勾选核对，确保"行为不变、净瘦身、依赖方向正确"。每个大项完成后跑对应验证再勾选。

通用前提（每次提交前必查）：

- [ ] 当前分支为 `dev` 或 `main`，未新建其他分支。
- [ ] commit message 为中文（技术名词/文件名/命令/版本号可保留原文）。
- [ ] 未混写 dev/main 业务数据。
- [ ] `git diff --check` 通过（无行尾空白、冲突标记）。
- [ ] 本次改动为净瘦身或行为等价，无"只搬家不减量"。

---

## 低风险

### R5 清理 re-export shim

改动点：

- [x] `src/db/training/archive.mjs`：调用方（`generate-training-data.impl.mjs`）改为直接 import `adapters/postgres/archive-repository.pg.mjs`，删除该 shim。
- [x] `src/adapters/telegram/sync-batch.adapter.mjs`：调用方（`telegram-sync.use-case.mjs`、`telegram-sync/image-processing.mjs`、测试 fixtures）改为直接 import `sync-batch-logic.adapter.mjs`，删除该 shim。
- [x] `src/telegram/commands.mjs`：调用方（`sync-batch-logic.adapter.mjs`、`src-boundary.test.mjs`）改为直接 import `command-registry.mjs` / `help.mjs`，删除该 shim（纯再 export，无分层入口价值）。
- [x] `src/telegram/index.mjs`：全仓库零引用，直接删除。
- [x] 其余 2–8 行 `index.mjs` barrel：确认 `adapters/postgres/index.mjs` 等为多消费方稳定聚合点，保留不动。

核对：

- [x] 全仓库搜索已无对被删 shim 的 import 残留。
- [x] 保留的 barrel 作为聚合点保留（本轮未新增/删除 barrel，维持现状）。
- [x] 净删除文件数为正（删除 4 个 shim，仅新增 import 路径调整）。

验证：

- [x] 全量测试：R5 变更未引入新失败（3 个既有失败均与 R5 无关：`update-dev-sql/` 缺失 SQL 文件 2 个 + 直近提交 f212815 引入的 `syncTrainingCore` shared-client 逻辑不一致 1 个）。
- [ ] `npm run build` 通过（依赖 DB，最终全量验证阶段再跑）。

> 附带修复：删除 `tools/sync-training-core.mjs:388` 的多余 `}`（HEAD 已存在的语法错误，导致 2 个测试文件无法加载）。属行为保存的显式 bug 修复，非 R5 范围但阻断测试基线，故一并修正。

### R2 方案 B（若选文档修正路线）

- [x] `docs/02_系统核心逻辑/系统总览.md` 分层描述修正为与实际 `core→domain` 依赖方向一致。
- [x] 不改任何代码（方案 B 为纯文档）。

> 读码判断：`training-domain.mjs` 的 `buildTrainingDay` 连锁依赖 `summarizeSleep`/`summarizeActivities`/`empty*`，`normalizeBatchActivity` 依赖 `normalizeActivityType`/`parseDurationSeconds`，方案 A 需搬迁 domain 大半内容并波及大量 import 方，超出“行为不变、纯移动”范围。实际 `core→domain` 为单向依赖、domain 为更底层的来源无关基础规则层，属自然方向，故选方案 B 纯文档修正。

---

## 中风险

### R4 拆分超大文件（纯物理拆分，禁止改逻辑）

每个源文件拆分后立即跑相关测试再进入下一个。

`sync-batch-logic.adapter.mjs`（1857 行）：

- [x] 按职责拆分：命令解析 → `sync-commands.adapter.mjs`（23 函数）、批次分析 → `sync-analysis.adapter.mjs`（30 函数）；消息分组 / Markdown 再导出 / 并发工具 `mapWithConcurrency` 保留在原文件（MAIN，12 函数）。
- [x] 所有原顶层函数导出名与签名保持不变（对外导入符号 `groupTelegramUpdates`/`groupSourceMessages`/`analyzeTelegramBatch`/`processTelegramBatch`/`processTelegramUpdates`/`mapWithConcurrency` 全部留在原路径，无需 re-export shim）。
- [x] import 方路径已同步更新（对外符号未移动，导入方零改动）。
- [x] 相关测试通过（`telegram-sync.test.mjs` 85/85）。

`telegram-sync.use-case.mjs`（1344 行）：

- [x] 拆分为：timings → `telegram-sync-timings.mjs`、env 装配 → `telegram-sync-env.mjs`、批次路由 → `telegram-sync-handlers.mjs`、随想处理 → `telegram-sync-thoughts.mjs`；`runMessageSync`/`runTelegramSync`/`createRecognitionAiProvider`/`main` 保留在 MAIN（原文件 1344 → 674 行）。
- [x] `runMessageSync` 等导出名与签名不变（去命名在 R3 处理，此处不改名）；原 `export { ... }` 再导出块与 CLI footer 原样保留。
- [x] import 方路径已同步更新（对外符号未移动，导入方零改动）。
- [x] 相关测试通过（`telegram-sync-runner.test.mjs` 135/135、飞书链路 117/117）。

`image-recognition.use-case.mjs`（1168 行）：

- [x] 拆分为：解析校验 → `image-recognition-parse.mjs`、schema 请求 → `image-recognition-schema.mjs`、provider 与 fallback → `image-recognition-provider.mjs`；缓存与编排保留在 MAIN（原文件 1168 → 336 行）。
- [x] 识别 schema 版本保持不变（`RECOGNITION_SCHEMA_VERSION` 从 `telegram-recognition-schema.mjs` 导入未改动），语义校验行为不变（纯移动）。
- [x] import 方路径已同步更新（对外符号 `recognizeTelegramImageMessage`/`buildRecognitionCacheKey`/`isRecognitionCacheEnabled`/`readRecognitionFromDatabaseCache` 未移动，导入方零改动）。
- [x] 相关测试通过（`ai-recognition-service.test.mjs`、`telegram-sync-runner.test.mjs` 160/160）。

核对：

- [x] 拆分只做"移动 + 精确 import"，无任何行为改动（逐函数与 HEAD 做 CR 归一化后字节比对，realDiff 均为 0；`telegram-sync.use-case.mjs` 仅 CLI footer 从末尾 def 位移到 MAIN，非改动）。
- [x] 无遗留空文件或重复定义（65+42+45 函数总数守恒，无重名跨文件）。

验证：

- [x] 逐文件拆分后即时测试通过（每拆一个文件立即跑相关测试再进入下一个）。
- [ ] 最终全量测试 + `npm run build` 通过（收尾阶段统一跑）。

### R2 方案 A（若选契约下沉路线，可选）

- [ ] 将 `domain/training/training-domain.mjs` 中被 Core 依赖的稳定契约（`buildTrainingDay`、`emptyNutrition`、`emptySleep`、类型规范化等）下沉到 `core`。
- [ ] `domain` 的 Markdown 解析类逻辑保留在 `domain`，改为单向依赖 `core`。
- [ ] `src/core/entities/*`、`src/core/services/*` 不再 import `domain`。
- [ ] 全仓库确认 `core→domain` 已无 import。
- [ ] 解析、合并、快照构建相关测试 + 站点构建通过。

---

## 高风险

### R1 合并 PostgreSQL 持久化双层

改动点：

- [ ] 以 `adapters/postgres` 为唯一 PG 适配层落点。
- [ ] `db/training/write.mjs` 的连接/查询实现迁入或单向依赖适配层。
- [ ] `db/training/read.mjs` 同上。
- [ ] `db/training/archive.mjs` 已在 R5 删除，调用方直连适配层。
- [ ] `db/training/config.mjs` 依赖方向理顺。
- [ ] 消除反向 import：`adapters/postgres/core-day-repository.pg.mjs` → `db/training/read.mjs`。
- [ ] 消除反向 import：`adapters/postgres/training-analysis-repository.pg.mjs` → `db/training/config.mjs`。

核对：

- [ ] 全仓库搜索 `adapters/postgres` 已不 import `db/training`（单向）。
- [ ] 入库/读取/分析/站点读取的所有 import 方路径已更新。
- [ ] 行为不变：入库结果、读取结果、分析产物一致。

验证：

- [ ] 入库、读取、分析、站点构建相关测试通过。
- [ ] 全量测试 + `npm run build` 通过。

### R3 共享编排器去 telegram 化命名（一次性全量改名，不留兼容 re-export）

改动点：

- [ ] `runMessageSync` 及渠道无关编排逻辑抽到中性模块（如 `src/app/use-cases/message-sync.use-case.mjs`）。
- [ ] `telegram-sync.use-case.mjs` 只保留 Telegram 特有装配。
- [ ] `feishu-sync.use-case.mjs` 改为 import 中性模块，不再 import `telegram-sync`。
- [ ] `feishu-sync` 对 `telegram-sync/image-processing.mjs`（`recognizeBatch`）、`telegram-sync/status.mjs` 的依赖改指中性位置。
- [ ] 重命名 `groupTelegramUpdates`、`processTelegramBatch`、`persistTelegramImageBatchIncremental` 等为 source 语义（对齐已有 `groupSourceMessages`）。
- [ ] `adapters/feishu/feishu-event.transport.mjs` 对 `../telegram/polling.transport.mjs` 的依赖评估是否一并中性化。

核对：

- [ ] 全部旧名引用一次性更新，无遗留旧名。
- [ ] 未保留旧名 re-export 兼容层（符合净瘦身前提）。
- [ ] 命令、识别结果、入库结果一致（外部行为不变）。
- [ ] `docs/02_系统核心逻辑` 中"源码事实入口表"已同步新模块名。

验证：

- [ ] Telegram 与飞书同步全链路测试通过。
- [ ] 全量测试 + `npm run build` 通过。

### R6 数据库遗留表清理（不可逆 DDL，须用户单独批准 + 人工执行）

前提：

- [ ] 已获得用户对本项的明确批准。
- [ ] 表结构变更的 SQL 已作为独立文件放入 `sql/dev-sql/update-dev-sql/`（本项对应 `20260714_drop_legacy_telegram_tables.sql`），由用户手动在 dev 数据库执行；AI 不直接执行 DDL。
- [ ] 由 `training_writer` 或 DBA 在目标环境手工执行，日常 workflow 不做 DDL。
- [ ] dev / main 分别独立操作，不混写。

待清理对象（共 4 表 + 1 序列，已修正方案原稿漏写的 `telegram_recognition`）：

- [ ] `ingest.telegram_recognition`（有 FK 指向 `telegram_batch`/`telegram_message`，需先删）
- [ ] `ingest.telegram_message`（有 FK 指向 `telegram_batch`）
- [ ] `ingest.telegram_batch`
- [ ] `ingest.telegram_pending_batch`
- [ ] 序列 `ingest.telegram_pending_batch_pending_id_seq`（当前 `setval=17`，表内可能有历史数据）

执行前核对：

- [ ] 再次确认 `src/` 中这 4 张表名作为表引用为零命中（`telegram_message_id` 是其他表的列名，非本表引用）。
- [ ] 确认主链路已用 `source_batch` / `source_message` / `recognition_run` / `pending_task` 替代。
- [ ] 确认无其他数据库对象（视图、函数、FK）依赖这些表。
- [ ] DROP 顺序遵循 FK 依赖：先 `telegram_recognition`，再 `telegram_message`，再 `telegram_batch` 与 `telegram_pending_batch`，最后序列。
- [ ] 若表内有需保留的历史数据，先归档再删。

执行后核对：

- [ ] 重新导出 `sql/dev-sql`（及 main 环境的 `sql/main-sql`）。
- [ ] `check:data-consistency` 通过。

---

## 落地收尾（全部阶段完成后，依据 `实施规划落地文档同步规则.md`）

- [ ] 每项重构的实际改动面已从代码、SQL、workflow、配置确认，行为未变。
- [ ] 净瘦身：删除文件数与代码行数为正。
- [ ] 全量测试通过（62 个测试文件），`npm run build` 与站点构建通过。
- [ ] 当前分层、命名、持久化层事实写回 `02_系统核心逻辑`（系统总览 / 数据库模型 / 数据入库流程 / 源码事实入口表）。
- [ ] `CHANGELOG.md` 记录 Changed / Removed。
- [ ] README 导航按需更新。
- [ ] `03_计划实施` 下的一次性方案与本 Checklist 在完成后删除（追溯用 Git 历史）。
- [ ] R6 若执行：dev/main 分别人工 DROP 并重新导出 SQL，数据一致性检查通过。
