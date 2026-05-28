# 系统优化重构方案（V5）

> 文档定位：本文档面向架构师、产品经理和后续开发人员，用于评估并指导系统在**不改变既有功能语义**的前提下，围绕**运行速度、可维护性、可迁移性**进行优化重构。
>
> 适用范围：当前仓库中的代码、`docs/` 文档、`sql/` 数据库表结构、GitHub Actions、Cloudflare Worker、Hexo 主题与前端脚本。
>
> 重要约束：**不改功能、不改用户可见行为、不改变数据口径、不改变 Telegram 命令语义、不改变站点展示结果**。所有重构都应满足可回滚、可验证、可逐步实施。

---

## 1. 文档目标

当前系统已经从“静态站点生成脚本”演进为一个集成了 **Markdown、PostgreSQL、Telegram 同步、AI 识别、Hexo 构建、GitHub Actions、Cloudflare Worker** 的轻量数据系统。系统功能完整，但随着能力扩展，代码边界、职责划分、运行效率和迁移成本逐渐成为主要问题。

本方案的目标不是重写系统，而是：

1. 先明确**现状基线**，避免把已经存在的能力当作“待建设项”。
2. 再明确**剩余差距**，只描述下一轮真正要做的优化。
3. 最后拆成**可执行任务包**，便于后续按 PR 逐步推进。
4. 给出一份独立的 checklist，方便按方案执行后逐项验收。

---

## 2. 当前实现基线

这一节只记录“已经存在”的能力，后续优化方案必须以此为前提，不得重复设计。

### 2.1 AI provider 已存在且已共用

- `src/ai/provider.mjs` 已存在。
- 图片识别、训练分析、AI agent 已经通过 provider 复用同一套调用路径。
- 因此本轮不再讨论“是否建立统一 provider”，而是补齐契约文档、测试和边界说明。

### 2.2 识别缓存已存在

- 识别缓存已存在，开关为 `TELEGRAM_RECOGNITION_CACHE_ENABLED`。
- cache key 已包含 `file_unique_id + promptVersion + schemaVersion + model`。
- 因此本轮不再设计新的缓存主结构，而是确认默认关闭、日志可见、回归可测。

### 2.3 prompt / schema metadata 已存在

- `prompts/*.md` 已承载 prompt 内容。
- `tools/prompt-generator.mjs` 已支持版本信息。
- prompt / schema 元数据不是空白能力，本轮关注的是版本变更策略、失效规则和文档索引。

### 2.4 DB 读取窗口已存在

- `readTrainingSnapshotFromDatabase` / `buildTrainingSnapshot` 已支持 `dateFrom/dateTo`。
- 因此本轮不是“新增窗口读取能力”，而是评估 dashboard / analysis 是否真正传入窗口参数；若未使用，应明确暂不启用原因。

### 2.5 Dashboard view model 已存在

- `source/_data/dashboardView.json` 已存在。
- `buildDashboardViewModel` 已存在。
- 但 `themes/cactus/layout/dashboard.ejs` 仍保留不少展示计算、数组组装和 HTML 拼接逻辑。
- 因此本轮重点是**模板瘦身**，不是重新设计看板数据模型。

### 2.6 现有流程编排与边界已部分存在

- `tools/training-domain.mjs`、`training-parser.mjs`、`training-snapshot.mjs` 已承担领域相关职责。
- `tools/training-db-*` 已承担数据库读写与归档职责。
- `tools/telegram-sync-lib.mjs` 已承载命令分组、批次分析、Markdown 应用等逻辑。
- `tools/telegram-sync.mjs`、`tools/training-analysis.mjs`、`tools/generate-training-data.mjs` 已是可执行入口。
- 这说明当前问题不是“完全没分层”，而是 `tools/` 和模板层仍有职责膨胀，`src/` 的边界尚未完整收束。

---

## 3. 当前系统概览

### 3.1 系统主链路

从仓库结构和文档分析，系统主链路大致如下：

1. 训练数据来源于 `训练记录.md` 或 PostgreSQL `core.*`。
2. 通过 `tools/generate-training-data.mjs` 生成 `source/_data/training.json` 与 `source/_data/dashboardView.json`。
3. Hexo + `themes/cactus` 将数据渲染为静态站点。
4. Telegram update 通过 Cloudflare Worker 转发到 GitHub `repository_dispatch`。
5. GitHub Actions 执行 `npm run sync:telegram`，完成图片识别、命令处理、数据库写入、Markdown 回退和站点部署。
6. `/analysis` 等命令会读取训练快照，再调用 AI 服务生成建议并回发到 Telegram。

### 3.2 已存在的关键模块

- `tools/training-parser.mjs`：解析训练 Markdown。
- `tools/training-snapshot.mjs`：统一构建 `TrainingSnapshot`。
- `tools/dashboard-view.mjs`：构建首页看板视图模型。
- `tools/training-db-read.mjs` / `tools/training-db-write.mjs` / `tools/training-db-archive.mjs`：数据库读写与归档。
- `tools/telegram-sync.mjs` / `tools/telegram-sync-lib.mjs`：Telegram 同步与批次处理。
- `tools/training-analysis.mjs`：训练分析与 AI 回复。
- `src/ai/*`：AI provider、schema 校验、识别服务。
- `src/telegram/command-registry.mjs`：Telegram 命令注册。
- `cloudflare/telegram-sync-dispatch-worker.mjs`：Webhook 入口。
- `themes/cactus/layout/dashboard.ejs`：首页渲染。

### 3.3 数据库结构摘要

根据 `sql/training_records/` 下的表结构，数据库分为三类核心域：

#### ingest

- `telegram_batch`
- `telegram_message`
- `telegram_recognition`

作用是承接 Telegram 原始同步数据、消息元数据、识别结果缓存或审计信息。

#### archive

- `training_day`
- `training_activity`
- `training_meal`
- `training_measurement`
- `training_parse_run`
- `training_parse_snapshot`

作用是保存构建快照、解析运行痕迹、历史归档明细。

#### core

从文档可知，`core.*` 是当前主事实源，用于看板读取、训练分析和回写结构化数据。

---

## 4. 问题诊断

### 4.1 运行速度方面的主要差距

#### 4.1.1 数据链路过长

当前一次同步或构建会穿过多个层级：

- Telegram update 解析
- update 分组与 batch 归一化
- AI 识别
- PostgreSQL 写入
- Markdown 回退
- 训练快照生成
- Dashboard 视图构建
- Hexo 生成

这条链路虽然完整，但耦合较高，部分步骤缺少清晰的中间产物复用机制，容易出现重复计算。

#### 4.1.2 仍存在可压缩的模板计算

`dashboard.ejs` 里仍有部分指标比较、数组组装和 HTML 拼接逻辑。模板承担的计算越多，越容易出现：

- 构建性能下降。
- 视图逻辑难测试。
- 前后端职责不清。

#### 4.1.3 数据库读取窗口尚未形成统一使用策略

窗口能力虽然已存在，但 dashboard / analysis / backfill 是否都按窗口调用并不一致。若未明确使用边界，就会出现“能力有了，但没有形成稳定策略”的情况。

### 4.2 可维护性方面的主要差距

#### 4.2.1 `tools/` 既是 CLI 又是业务层

目前 `tools/` 同时承担：

- 命令入口
- 业务编排
- 数据处理
- 数据库写入
- AI 调用
- Markdown 生成

这会导致新开发者难以判断“逻辑应该写在哪里”。一旦需要新增命令或新数据处理流程，`tools/` 容易继续膨胀。

#### 4.2.2 Telegram 命令解析边界仍不够集中

Telegram 命令相关逻辑涉及：

- 路由优先级
- 命令别名
- message / edited_message / reply 处理
- 相册分组
- `/analysis` 与普通图片的分流

如果这些逻辑散落在多个脚本中，后续新增命令时很容易引入回归。

#### 4.2.3 数据库 SQL 与业务编排仍耦合

读写数据库的代码需要同时处理：

- SQL 语句
- payload hash
- 幂等策略
- transaction 语义
- 归档规则
- archive/core/ingest 的职责划分

这会让数据库代码难以维护，也不利于未来迁移到其他存储层。

#### 4.2.4 运行期产物仍分散

系统中存在多个运行期写入位置：

- `source/_data/`
- `runtime/*.ndjson`
- `source/_posts/`
- `source/images/`
- PostgreSQL 各 schema

缺少统一的运行状态抽象，后续排障、回放和迁移会更复杂。

### 4.3 可迁移性方面的主要差距

#### 4.3.1 对 GitHub Actions 依赖较强

当前同步、构建、发布流程非常依赖 GitHub Actions。若未来需要迁移到其他 CI/CD 或自建运行环境，必须先梳理：

- 哪些是业务逻辑
- 哪些是 workflow 编排
- 哪些是部署环境绑定

#### 4.3.2 对 Cloudflare Worker 运行时依赖较强

Worker 承担 webhook 入口和相册聚合。如果未来要迁移入口层，需要将：

- secret 校验
- dispatch 触发
- 相册缓冲
- 命令快速回复

从 runtime 绑定中抽离为可复用逻辑。

#### 4.3.3 数据事实源切换成本高

目前 Markdown 与 PostgreSQL 并存，且存在“主事实源”和“回退源”的双向关系。未来如果要让数据库成为默认事实源，必须解决：

- 导入导出一致性
- 回退策略
- 运行期幂等
- 历史数据对账

这类切换不能直接通过改一个配置完成。

---

## 5. 不可改边界

这一节用于冻结本轮重构必须保持不变的协议和行为，后续所有任务包都不得突破。

### 5.1 不变项

- npm scripts 名称不变。
- Telegram 命令 alias、优先级、batch 顶层字段不变。
- `client_payload.telegram_updates` 协议不变。
- `TrainingSnapshot`、`dashboardView.json` 对外字段不变。
- `训练记录.md` fallback 语义不变。
- `runtime/telegram-sync-pending.ndjson` 补偿语义不变。
- PostgreSQL 现有 schema 和 payload hash 幂等语义不变。
- 页面展示结果不变。
- 数据口径不变。

### 5.2 说明

如果某项优化会触及上面的不变项，应该先改写方案，而不是直接纳入当前 V5 执行范围。

---

## 6. 优化目标

本次优化重构的目标分为四类：

### 6.1 性能目标

- 加固识别缓存边界，降低重复 AI 识别风险。
- 减少不必要的全量读取。
- 减少模板层计算。
- 降低重复构建与重复导出。

### 6.2 可维护性目标

- 明确 domain / adapter / job / ui 的边界。
- 让 `tools/` 只保留 CLI 入口职责与兼容层职责。
- 让 Telegram 命令解析、AI 分析、数据库操作更模块化。
- 增加统一测试保护。

### 6.3 可迁移性目标

- 让业务逻辑尽量摆脱具体运行环境。
- 让 CI/CD、Worker、Hexo、DB 的耦合降到最低。
- 为未来迁移到独立服务、队列或其他数据库预留接口。

### 6.4 稳定性目标

- 不改变现有功能结果。
- 不改变用户侧命令语义。
- 不改变页面输出。
- 不改变数据库现有数据口径。
- 所有优化都可通过测试验证。

---

## 7. 评估结论与总体方案

建议采用“**先分层、再提速、后迁移**”的三阶段路线。

### 阶段 1：结构梳理与职责拆分

目标是让系统从“脚本集合”变成“有清晰边界的模块体系”。

重点：

- 梳理 `src/` 分层。
- 将纯函数、领域逻辑、视图模型、命令解析从 `tools/` 中逐步迁出。
- 保留现有 CLI 入口和 npm scripts 不变。
- 增加 targeted tests，先锁定关键行为。

### 阶段 2：性能优化与统一抽象

目标是在不改功能前提下，提升运行效率和可扩展性。

重点：

- 补齐 provider 契约文档和测试，不重做 provider。
- 完善 prompt/schema 版本变更策略、缓存失效说明、文档索引。
- 确认识别缓存默认关闭、命中/未命中日志、缓存回归测试。
- 评估 dashboard / analysis 是否实际传入窗口参数；未使用则写清暂不启用原因。
- 模板瘦身，处理 `themes/cactus/layout/dashboard.ejs` 里的指标比较、数组组装、HTML 拼接逻辑。
- 收敛 DB repository 内部边界。

### 阶段 3：迁移准备与长期演进

目标是为未来的架构迁移做准备，而不是现在就重构上线结构。

重点：

- pending store 从文件演进到数据库可选实现。
- 默认事实源切换的评估。
- 独立服务化 / 队列化的前置接口设计。
- 更强的可观测性和审计能力。

---

## 8. 执行拆解概览

### 8.1 第一优先级：结构与边界

- P0-1 到 P0-6 与正文保持一一对应，状态表述统一为“已有基础，仍需收口 / 部分完成 / 未开始”。

| 编号 | 任务包 | 当前状态 | 目标 | 交付物 | 风险 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | 建立 `src/` 分层骨架 | 已有基础，仍需收口 | 为 domain / adapter / job / ui 提供清晰落点 | 新目录与基础文件 | 低 | 无 |
| P0-2 | 迁移训练领域逻辑 | 已有基础，仍需收口 | 降低 `tools/` 膨胀 | `tools/training-domain.mjs`、`training-parser.mjs`、`training-snapshot.mjs` 逐步迁入 `src/domain/training/`，`tools/` 保留兼容入口 | 低 | P0-1 |
| P0-3 | 收敛 DB 读写归档边界 | 已有基础，仍需收口 | 让 SQL 只落在 DB 层，并保留 facade 兼容 | `tools/training-db-*` 规划迁移到 `src/db/`，拆成 config、read repository、write repository、archive repository；`tools/training-db-core.mjs` 继续作为 facade / 兼容层 | 中 | P0-1 |
| P0-4 | 收敛 Telegram 同步流程边界 | 已有基础，仍需收口 | 让 CLI 只负责调度 | 将 `tools/telegram-sync-lib.mjs` 中的命令分组、批次分析、Markdown 应用逻辑拆到 `src/telegram/` 或 `src/domain/telegram/`；`tools/telegram-sync.mjs` 只保留 CLI/job 调用 | 中 | P0-1 |
| P0-5 | 收敛 Dashboard view model | 已有基础，仍需收口 | 模板只消费 view model | 将 `tools/dashboard-view.mjs` 迁移到 `src/site/dashboard-view.mjs`，并冻结 view model 字段 | 中 | P0-1 |
| P0-6 | 补齐关键测试 | 部分完成 | 锁定行为，避免回归 | targeted tests；补齐 Telegram 命令路由、analysis 意图识别、DB 幂等与 transaction、dashboard view model 快照、parser / snapshot 输出稳定性测试 | 低 | P0-1、P0-2 |

### 8.2 第二优先级：性能与抽象

- P1-1 到 P1-6 与正文保持一一对应，状态表述统一为“已有基础，待补强 / 待确认 / 待收口”。

| 编号 | 任务包 | 当前状态 | 目标 | 交付物 | 风险 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-1 | AI provider 契约加固 | 已存在，待补强 | 补齐 provider 文档和测试 | provider 契约说明、错误分类、测试覆盖 | 中 | P0-1 |
| P1-2 | Prompt / schema 版本策略补齐 | 已存在，待补强 | 支持回溯与缓存失效 | 版本元数据、加载机制、索引文档 | 中 | P1-1 |
| P1-3 | 识别缓存加固 | 已存在，待补强 | 降低重复 AI 成本 | 默认关闭说明、命中/未命中日志、缓存回归测试 | 中 | P1-1、P1-2 |
| P1-4 | DB 读取窗口使用策略 | 已存在，待确认 | 让窗口能力真正可控 | 评估 dashboard / analysis 是否传参；未使用则写清原因 | 中 | P0-2 |
| P1-5 | Dashboard 模板瘦身 | 已存在，待收口 | 减少模板层计算 | `dashboard.ejs` 不再计算训练指标 delta、ratio、overviewStats、chartCards，只渲染 view model 字段 | 中 | P0-5 |
| P1-6 | DB repository 边界化 | 已存在，待收口 | 分离 SQL 与业务编排，并统一 DB 层入口 | DB SQL 查询只出现在 `src/db/**` 和兼容 facade，不散落在 job/telegram/domain 模块 | 中 | P0-3 |

### 8.3 第三优先级：迁移准备

- P2-1 到 P2-4 与正文保持一一对应，状态表述统一为“未开始 / 待预留 / 待评估”。

| 编号 | 任务包 | 当前状态 | 目标 | 交付物 | 风险 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| P2-1 | pending store 设计 | 未开始 | 为 ndjson 队列提供替代方案 | 可选数据库 pending 实现 | 高 | P1-6 |
| P2-2 | database 事实源评估 | 未开始 | 为未来迁移铺路 | 迁移评估文档与对账流程 | 高 | P1-4、P1-6 |
| P2-3 | jobs 分层预留 | 未开始 | 降低未来服务化成本 | `src/jobs/` 规划：`telegram-sync-job`、`generate-training-data-job`、`training-analysis-job` | 中 | P0-1、P1-1 |
| P2-4 | 服务化迁移接口预留 | 未开始 | 让未来服务化/队列化更容易落地 | job 与 adapter 的稳定接口约定 | 中 | P0-1、P1-1 |

---

## 9. 详细方案

# 第一阶段：结构梳理与职责拆分

## 9.1 目标

- 降低 `tools/` 的复杂度。
- 建立清晰模块边界。
- 保持所有现有脚本和工作流兼容。
- 用测试保护重构边界。

## 9.2 建议拆分方向

### 9.2.1 领域层

建议将以下能力迁移或沉淀为 domain 层：

- 训练快照模型。
- 训练数据解析。
- 日级统计与聚合。
- 训练分析摘要结构。
- 随想相关的状态模型。

### 9.2.2 适配层

建议将以下能力抽成 adapter/repository：

- Telegram API 调用。
- AI provider 调用。
- PostgreSQL 读写。
- Hexo 命令执行。
- Cloudflare Worker dispatch。

### 9.2.3 作业层

建议把以下流程定义为 job：

- Telegram sync job。
- Site build job。
- Markdown import/export job。
- Archive / backfill job。
- Analysis job。

### 9.2.4 展示层

建议把 dashboard 相关逻辑收敛为：

- 数据准备。
- view model 构建。
- 模板只做展示。

## 9.3 预期收益

- 新增功能时更容易定位代码。
- 重构风险降低。
- 测试粒度更清晰。
- 将来迁移服务或替换实现时更方便。

## 9.4 验收标准

- 所有现有 npm scripts 保持可用。
- Telegram 命令输出不变。
- 页面输出不变。
- `npm test` 和 `npm run build` 保持通过。

---

# 第二阶段：性能优化与统一抽象

## 9.5 目标

在不改变系统行为的基础上，优化速度、稳定性和扩展性。

## 9.6 建议优化项

### 9.6.1 AI provider 契约加固

当前 provider 已存在，本轮只补齐其契约说明和测试，避免把已完成能力误写成新建项。

**收益**：

- 后续切换 AI 服务商时只需改 adapter，不影响业务逻辑。
- 提升错误可读性和排查效率。

### 9.6.2 识别结果缓存加固

以 `file_unique_id + promptVersion + schemaVersion + model` 为核心的缓存键已经存在，本轮重点是边界说明和验证。

**收益**：

- 重跑同步时减少重复识别。
- 重复图片不重复花费 AI 资源。
- 提高 workflow 稳定性和成本可控性。

**要求**：缓存默认关闭，避免首次引入时改变行为；增加命中/未命中日志；补充回归测试。

### 9.6.3 Prompt / schema 版本策略补齐

确认并规范 prompt 文件中的稳定版本号或版本常量，让缓存、回放和回归测试都有稳定依据。

**补齐内容**：

- 为 prompt 文件确认并规范稳定版本号或版本常量，避免仅依赖文件名变化。
- 为 schema 增加显式版本字段，并在识别结果中保留对应版本元数据。
- 让缓存键、回放记录、测试样本都能追溯到同一组版本信息。
- 将版本升级与兼容策略写清楚，避免旧缓存和新 schema 互相污染。

**收益**：

- prompt 更新时可精确失效旧缓存。
- schema 演进时可保留历史兼容性。
- 方便定位某次识别结果对应的版本上下文。

### 9.6.4 DB 读取窗口使用策略

明确哪些查询可以使用窗口参数，哪些场景必须保持全量读取，避免统计口径被悄然改变。

**补齐内容**：

- 明确 `dateFrom` / `dateTo` 只作为可选过滤条件，不默认改变既有全量语义。
- 区分 dashboard、analysis、导出、排查四类读取场景的使用边界。
- 对所有窗口读取调用补充默认值、空值与边界日期的处理约定。
- 在正文中明确：若业务不需要窗口，就保持全量读取，不要为了“看起来更快”而改变口径。

**收益**：

- dashboard 与 analysis 的读取语义更清晰。
- 降低误用窗口参数导致的口径偏差。
- 便于后续将窗口能力作为显式配置项管理。

### 9.6.5 Dashboard 模板瘦身

将页面模板中的计算逻辑收拢到 view model 层，模板只负责展示。

**补齐内容**：

- 将 delta、ratio、overviewStats、chartCards 等派生字段前移到 view model。
- 模板只消费最终展示字段，不再做业务运算。
- 固定输出字段结构，减少页面层分支和条件计算。
- 让 snapshot 测试直接覆盖 view model 输出，降低模板变更噪音。

**收益**：

- 降低模板复杂度。
- 提升页面字段稳定性。
- 让快照测试更容易锁定输出。

### 9.6.6 DB repository 边界化

进一步明确 DB SQL 只出现在 repository 层，避免业务编排层散落读写细节。

**补齐内容**：

- `ingest`、`core`、`archive`、`thought` 等写入逻辑统一收口到 repository。
- job、domain、telegram 层只调用 repository 暴露的方法，不直接拼 SQL。
- 事务、重试、错误分类、幂等判断尽量在 repository 边界内完成。
- 兼容层仅保留转发，不再继续扩展新的 SQL 实现。

**收益**：

- 更容易替换存储实现。
- 让 job / domain / telegram 层保持纯粹。
- 方便统一管理事务、重试和错误分类。

## 9.7 验收标准

- 识别结果、分析结果、页面数据口径不变。
- 缓存默认关闭，不影响当前行为。
- Prompt / schema 版本、DB 读取窗口、Dashboard view model、DB repository 边界均已补齐说明。
- CI 和部署流程无需改动。

---

# 第三阶段：迁移准备与长期演进

## 9.8 目标

为未来的架构迁移提供更稳定的能力边界，而不是现在直接替换现有运行环境。

## 9.9 建议优化项

### 9.9.1 pending store 设计

为 runtime 文件队列提供可选数据库替代方案。

- 保留 file 作为默认实现。
- database 作为可选实现。
- replay 逻辑保持可切换。

### 9.9.2 database 事实源评估

评估未来让数据库成为默认事实源的可行性。

- 明确 Markdown 与 DB 的主从关系。
- 评估导入导出一致性。
- 评估 fallback 与对账成本。

### 9.9.3 jobs 分层预留

为后续服务化或队列化迁移保留稳定的作业边界。

- `telegram-sync-job`
- `generate-training-data-job`
- `training-analysis-job`

### 9.9.4 服务化迁移预留接口

降低未来从 GitHub Actions / Worker 迁移到常驻服务或队列系统的成本。

- 让 job 与 adapter 接口稳定。
- 让业务逻辑尽量不依赖运行环境。
- 让编排与实现更容易替换。

## 9.10 验收标准

- 业务逻辑与运行环境解耦程度提高。
- 不影响现有部署链路。
- 迁移评估材料完整。

---

## 10. 风险分析

### 10.1 技术风险

| 风险项 | 风险等级 | 说明 | 缓解方式 |
| --- | --- | --- | --- |
| 模块拆分导致导出不兼容 | 中 | 旧脚本可能依赖旧导出 | 保留兼容层、保持 re-export |
| AI provider 契约调整引入误差 | 中 | 请求/响应处理变化可能影响识别 | 增加 schema 校验和 targeted tests |
| 缓存导致旧结果误命中 | 中 | prompt/model/schema 变化可能命中旧缓存 | 缓存键绑定版本字段 |
| DB 读取窗口影响统计口径 | 中 | 局部窗口与全量语义不同 | 默认仍全量，窗口仅作为可选参数 |
| Dashboard 迁移影响视觉 | 低 | 模板逻辑前移后数据结构变化 | 先冻结视图字段，再迁移模板 |

### 10.2 业务风险

| 风险项 | 风险等级 | 说明 | 缓解方式 |
| --- | --- | --- | --- |
| Telegram 语义改变 | 高 | 用户命令是核心入口 | 明确冻结命令行为，保持兼容 |
| 数据库回写口径改变 | 高 | 影响历史数据一致性 | 先锁定 schema 和幂等规则 |
| 构建结果变化 | 中 | 站点生成结果可能变化 | 以 snapshot-like 测试保护 |
| 回退机制失效 | 高 | DB 异常时可能丢数据 | 保留 Markdown fallback |

### 10.3 迁移风险

| 风险项 | 风险等级 | 说明 | 缓解方式 |
| --- | --- | --- | --- |
| 未来迁移到独立服务困难 | 中 | 当前耦合度偏高 | 先做分层和接口化 |
| 从 Markdown 迁移到 DB 事实源风险大 | 高 | 数据源切换涉及全链路 | 单独评审，不与当前阶段混做 |
| 运行环境变化导致部署失败 | 中 | GitHub Actions / Worker 绑定复杂 | 不修改现有部署配置，先做内部重构 |

---

## 11. 推荐架构原则

### 11.1 分层原则

建议采用以下逻辑分层：

- `domain`：只放业务规则和纯逻辑。
- `adapter`：放外部服务适配，如 Telegram、AI、DB、Hexo。
- `job`：放流程编排。
- `ui`：放页面展示和 view model。
- `tools`：只保留 CLI 入口和兼容层。

### 11.2 单一职责原则

每个文件尽量只做一类事情：

- 解析文件只解析。
- 视图文件只构建视图。
- Repository 只处理数据库。
- Job 只编排步骤。
- Adapter 只负责对接外部。

### 11.3 向后兼容原则

任何重构都不应改变以下内容：

- npm scripts 名称。
- Telegram 命令语义。
- 页面路由和标题。
- 数据库主键与现有字段。
- 备份/回退机制。
- GitHub Actions 与 Cloudflare 的现有部署协议。

### 11.4 可测试原则

每个拆分点必须有对应测试：

- parser / snapshot。
- telegram command router。
- analysis summary。
- DB repository。
- dashboard view model。
- Worker dispatch。

### 11.5 分层硬规则

以下规则作为本轮重构的硬约束，需要写入正文并在 checklist 中验收：

- `domain` 层不得读取 `process.env`。
- `domain` 层不得访问文件系统。
- `domain` 层不得直接 `import pg`。
- `domain` 层不得直接调用 `fetch`。
- `domain` 层不得直接调用 Hexo API。
- 任何外部 IO 都应通过 `adapter`、`repository` 或 `job` 边界进入。
- `src/shared` 仅放纯函数、通用类型和无副作用工具。
- `tools/` 只保留 CLI 入口与兼容层，不承载新业务逻辑。

---

## 12. 建议优先级清单

### P0：必须先做

1. 建立 `src/` 分层骨架。
2. 迁移训练领域逻辑。
3. 收敛 DB 读写归档边界。
4. 收敛 Telegram 同步流程边界。
5. 收敛 Dashboard view model。
6. 补充关键 targeted tests。

### P1：优先做

1. AI provider 契约加固。
2. Prompt / schema 版本策略补齐。
3. 识别缓存加固。
4. DB 读取窗口使用策略。
5. Dashboard 模板瘦身。
6. DB repository 边界化。

### P2：中长期做

1. DB pending store 演进。
2. database 作为默认事实源的评估。
3. 更完整的运行审计和回放机制。
4. 服务化/队列化迁移准备。
5. `src/jobs/` 统一承接流程编排。

---

## 13. 适合架构评审的决策点

以下问题建议架构师和产品经理逐项评审：

### 13.1 系统边界是否要继续维持当前形态

- 继续以 GitHub Actions + Cloudflare Worker + PostgreSQL + Hexo 作为当前架构，还是逐步服务化？
- 当前规模是否值得引入更复杂的常驻服务？

### 13.2 Markdown 与数据库的主从关系是否要调整

- 目前 Markdown 既是人工维护源，也是数据库失败时的 fallback。
- 未来是否希望数据库成为默认事实源？
- 如果要切换，切换节奏和回滚方案是什么？

### 13.3 AI 能力是否要进一步产品化

- `/analysis` 只回发 Telegram，还是未来要做静态摘要页、历史对比页、趋势页？
- 识别缓存是否要长期投入？
- 是否需要更完整的 AI 可观测性？

### 13.4 Telegram 命令体系是否要扩展

- 当前命令已覆盖随想、删除、编辑、移动、分析。
- 是否需要统一命令注册和权限模型？
- 是否需要更多结构化交互？

---

## 14. 交付物建议

如果后续要真正推进优化重构，建议把交付物拆成以下几类：

### 14.1 设计文档

- 目标架构说明
- 模块边界说明
- 数据契约说明
- 迁移顺序说明
- 回滚方案说明

### 14.2 开发任务单

- 每个任务一个小 PR。
- 每个 PR 只解决一个边界问题。
- 每个 PR 附带测试说明。

### 14.3 验证清单

- 单元测试。
- 集成测试。
- 构建测试。
- 部署验证。
- 关键场景回归验证。

---

## 15. 最终结论

本系统的主要问题不是“功能不足”，而是“边界逐渐复杂”。如果继续以脚本堆叠方式扩展，后续维护成本、迁移成本和故障排查成本会逐步升高。

因此，推荐的重构路线是：

1. **先对齐现状基线**，避免把已存在能力误写成待建设项。
2. **再拆边界**，把职责分清。
3. **再做提速**，通过缓存、窗口读取和视图前移降低开销。
4. **最后做迁移准备**，为未来事实源切换和服务化留接口。

只要坚持以下原则，重构就能安全推进：

- 不改功能。
- 不改结果。
- 不改命令语义。
- 不改部署协议。
- 不改数据口径。
- 每步都有测试。

这份 `re_optimization_v5.md` 可作为后续架构评审和开发拆解的基础文档，也可作为执行清单的源文档。
