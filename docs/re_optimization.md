# 系统重构与优化分析报告（re_optimization）

## 1. 报告范围

本报告基于当前仓库实际文件结构进行静态分析，目标是在不改变现有功能、接口行为、数据获取方式、数据库 schema 与构建流程的前提下，为后续结构优化、性能优化与冗余清理提供决策依据。

本次交付只做分析，不包含任何代码实现。

## 2. 当前项目结构总览

### 2.1 系统类型

当前项目是一个围绕训练记录运转的 Hexo 静态站点与 Node.js 数据工具链，主要数据来源包括：

- `训练记录.md`：人工可读、人工维护、PostgreSQL 失败时的 Markdown 回退落点。
- PostgreSQL `core.*`：Telegram 自动同步后的主结构化数据层。
- PostgreSQL `archive.*`：Markdown 解析快照与历史归档层。
- Telegram webhook / polling：自动接收截图、识别结果和 `/thought` 随想。
- `source/_data/training.json` 与 `source/_data/dashboardView.json`：Hexo 页面渲染使用的生成数据。

### 2.2 目录职责

| 位置 | 当前职责 | 优化关注点 |
| --- | --- | --- |
| `tools/` | 数据解析、数据库读写、Telegram 同步、Hexo 数据生成、Markdown 导入导出 | 核心复杂度集中，部分文件职责偏大 |
| `cloudflare/telegram-sync-dispatch-worker.mjs` | Telegram webhook 转 GitHub `repository_dispatch`，并对相册消息做缓冲聚合 | 逻辑相对独立，可保持边界 |
| `themes/cactus/layout/` | Hexo EJS 模板，包含 dashboard、thoughts、post 等页面 | `dashboard.ejs` 承担较多数据派生与 HTML 渲染逻辑 |
| `themes/cactus/source/js/` | 前端交互脚本，含 dashboard 图表与分页 | 前端渲染路径可继续轻量化 |
| `themes/cactus/source/css/` | 主题样式与 dashboard 样式 | 可评估主题原始资源与实际使用资源的保留边界 |
| `test/` | Node test 测试集，覆盖 parser、DB、Telegram、dashboard、workflow | 测试覆盖较完整，是后续重构的安全网 |
| `.github/workflows/` | GitHub Pages、Telegram Sync、Cloudflare Worker 部署 | 多工作流共享 DB 环境变量与构建步骤，可分析重复配置 |
| `docs/` | 系统说明与维护文档 | 可作为后续重构路线和行为约束的来源 |
| `prompts/` | Telegram 图片识别 prompt | 与识别输出 schema 和日期解析强相关 |
| `sql/pgsql17.sql` | PostgreSQL schema | 后续结构优化默认不改 schema |
| `telegram/` | Telegram inbox、state、process log 等同步运行态/样例数据 | 存在运行态文件被纳入版本管理的清理空间 |

## 3. 关键发现摘要

| 优先级 | 位置 | 类型 | 发现 | 建议 |
| --- | --- | --- | --- | --- |
| P0 | `themes/cactus/layout/dashboard.ejs`、`tools/dashboard-view.mjs` | 重复逻辑 | dashboard fallback view model 与正式 view model 有大量重复日期规范化、图表过滤、概览卡片派生逻辑 | 优先统一到生成阶段，模板只消费 `dashboardView.json`，必要兜底保持最小化 |
| P0 | `tools/training-db-core.mjs` | 文件职责过重 | 单文件同时承担 config、连接、读取、批次入库、snapshot 构建、Markdown 导出、archive backfill | 按数据库读、写、导出、batch merge 拆分模块 |
| P0 | `tools/telegram-sync-lib.mjs` | 文件职责过重 | 单文件同时负责 update 分组、日期解析、识别结果归一化、Markdown 渲染、指纹去重、thought 命令解析 | 按 batch 分析、日期解析、Markdown 渲染、通用工具拆分 |
| P1 | `tools/telegram-sync.mjs` | IO 与流程复杂度 | 同步主流程包含 pending replay、事件解析、AI 识别、DB 写入、Markdown fallback、重新导出与报告构建 | 拆出 runner orchestration 与副作用服务，降低回归风险 |
| P1 | `tools/generate-training-data.mjs` | 重复读取/写入 | 无论 snapshot 来源是否为 database，都先读取 `训练记录.md` 用于 archive 持久化 | 后续可评估 lazy read，但需保留 archive 行为 |
| P1 | `telegram/inbox/*.ndjson`、`telegram/state.json`、`telegram/process-log.ndjson` | 冗余/运行态 | `.gitignore` 已忽略这些路径，但当前仍有历史文件被跟踪 | 明确哪些是测试夹具，非夹具运行态可迁移或清理 |
| P2 | `.github/workflows/deploy-pages.yml`、`.github/workflows/telegram-sync.yml` | 配置重复 | Node 安装、DB env、backfill/reconcile 步骤重复 | 通过文档化约束或复用 action 降低维护成本 |
| P2 | `themes/cactus/source/lib/`、`themes/cactus/languages/`、`themes/cactus/source/css/_highlight/` | 静态资源体积 | 主题保留了大量字体、多语言和代码高亮资源 | 谨慎评估实际站点是否使用，避免误删主题依赖 |

## 4. 性能优化分析

### 4.1 数据库读取与写入路径

#### `tools/training-db-core.mjs`

当前问题：

- 文件体量约 1131 行，是当前核心数据层复杂度最高的模块。
- `readTrainingSnapshotFromDatabaseClient` 分别查询 `core.training_day`、`core.measurement`、`core.activity`、`core.meal` 后在内存中 group，逻辑清晰但每次 snapshot 构建至少 4 次数据库交互。
- `readArchiveTrainingSnapshotFromDatabaseClient` 对 `archive.*` 采用类似读取方式，与 `core.*` 读取结构重复。
- `readCoreDay` 在单个 batch merge 前分别读取 day、measurement、activity、meal，用于合并已有记录；Telegram 高频同步时，每个 ready batch 都可能触发多次查询。
- `replaceCoreDay` 通过删除当天 `measurement/activity/meal/training_day` 后重插入完成整日替换，行为简单可靠，但属于写放大策略。

优化建议：

- 短期不改变 SQL 行为，仅把 `core` 与 `archive` snapshot 读取中的重复映射逻辑抽为共享 builder，降低维护成本。
- 中期评估在 `persistNormalizedBatch` 内对同一 `archivedDate` 的多个 ready batch 做内存级合并后再写库，减少重复 `readCoreDay` 与 `replaceCoreDay`。
- 中期评估将 `readCoreDay` 的 4 次查询封装为明确的 repository 方法，便于后续优化为单个事务内的批量读取。
- 长期如数据量增长，再评估 SQL join 或 JSON aggregation；当前数据规模下优先级低于结构拆分。

风险等级：中。数据库路径是主数据链路，任何优化都必须以 `test/training-db-core.test.mjs`、`test/training-snapshot.test.mjs`、`test/telegram-sync-runner.test.mjs` 回归为前置条件。

预期收益：减少重复查询和写放大，为 Telegram 批量导入或未来更高频同步提供空间。

### 4.2 Telegram 同步主流程

#### `tools/telegram-sync.mjs`

当前问题：

- 文件体量约 809 行，承担 CLI 入口、环境变量解析、pending queue 重放、Telegram update 获取、GitHub event 读取、AI 调用、DB 持久化、Markdown fallback、thought post 写入、报告输出。
- `runTelegramSync` 中 Markdown fallback、database export、rebuild markdown 等路径交织，认知成本较高。
- `fallbackMarkdown` 会在流程前段读取，后续只有 fallback 或 Markdown 重建路径才真正需要完整 Markdown 内容。
- pending queue 使用 `runtime/telegram-sync-pending.ndjson` 逐行 JSON 读写，当前简单可靠，但队列异常行、并发写入和大文件增长没有进一步治理。

优化建议：

- 将副作用适配层拆分为独立模块：Telegram API、AI recognition、pending queue、thought post writer、Markdown fallback writer。
- 保持 `runTelegramSync(options)` 对测试和外部调用的接口不变，只把内部流程拆成小步骤。
- 将 Markdown 读取延迟到 fallback 或 rebuild 确实需要时，避免 database 成功且无需回写时的重复 IO。
- 为 pending queue 增加只读分析文档或后续测试，明确“损坏行如何处理”“重放成功后何时截断”“repository_dispatch 与 workflow 并发边界”。

风险等级：中高。该文件串联自动同步主链路，建议分阶段小步拆分，不建议一次性重写。

预期收益：降低同步链路修改风险，减少不必要文件 IO，提升未来新增消息类型或补偿策略时的可维护性。

### 4.3 Telegram batch 分析与 Markdown 渲染

#### `tools/telegram-sync-lib.mjs`

当前问题：

- 文件体量约 1069 行，包含 update 分组、图片/文档识别归一化、日期解析、batch 状态判断、Markdown 拼接、block merge、fingerprint、thought 命令解析等多类职责。
- 日期解析相关函数集中在文件后半段，例如 `extractDateFromText`、`normalizeDateParts`、`parseMonthDay`、`isReasonableYear`，与 Markdown 渲染函数混在同一模块。
- `appendMetric` 在该文件与 `tools/training-db-core.mjs` 都存在类似用途，属于低风险重复工具。
- Markdown 渲染输出是行为敏感点，必须保持生成文本完全兼容。

优化建议：

- 第一阶段只抽出纯函数模块，不改变导出接口：日期解析、Markdown block 渲染、fingerprint、batch normalization。
- 保持 `processTelegramUpdates`、`analyzeTelegramBatch`、`applyTelegramSyncToMarkdown` 的外部行为不变。
- 为日期解析单独建立测试分组，继续复用 `test/telegram-sync.test.mjs` 中现有日期场景。
- 将通用格式化工具收敛到共享模块，避免不同路径格式口径漂移。

风险等级：中。该模块测试覆盖较丰富，但日期和 Markdown 文本格式对数据归档影响很大。

预期收益：显著降低单文件认知负担，减少后续调整 prompt 或日期口径时的误伤面。

### 4.4 数据生成路径

#### `tools/generate-training-data.mjs`

当前问题：

- 文件负责构建 snapshot、写 `source/_data/training.json`、写 `source/_data/dashboardView.json`、写 `训练数据解析.md`，并尝试持久化 archive。
- 即使 `TRAINING_SNAPSHOT_SOURCE=database`，当前也会读取 `训练记录.md`，用于 archive 持久化输入。
- 当 database snapshot 不可用时，会 fallback 到 Markdown，行为合理但错误判断依赖 `training-snapshot` 中的错误 message pattern。

优化建议：

- 保持当前功能不变，先在报告或后续代码注释中明确读取 `训练记录.md` 的原因是 archive 持久化，不应误删。
- 后续可把“生成站点数据”和“archive 持久化”拆为两个内部阶段，使 database 模式下的 Markdown 读取成为显式依赖。
- 将 `resolveSnapshotSource` 与 `tools/training-snapshot.mjs` 中同名职责合并或复用，避免配置解析口径重复。

风险等级：中。该脚本是 GitHub Pages 构建入口，任何改动都影响站点发布。

预期收益：减少重复配置解析，明确 IO 边界，为 database-only 构建模式做准备。

### 4.5 前端 dashboard 渲染

#### `themes/cactus/source/js/training-dashboard.js`

当前问题：

- 脚本从页面内 JSON script 解析 chart payload 和 daily entries，并负责图表绘制、分页与状态更新。
- 数据量当前较小，前端性能不是主要瓶颈。
- 如果 `dailyOverviewEntries` 长期增长，客户端一次性 JSON parse 与完整列表保存在 DOM payload 中会逐渐变重。

优化建议：

- 短期保持当前实现，不引入前端状态框架或异步接口。
- 中期可在生成阶段限制前端 payload 中的默认数据范围，历史全量数据通过静态分页或预生成文件提供。
- 优先减少 EJS 模板中的派生逻辑，再考虑前端交互优化。

风险等级：低。前端只消费生成数据，优化空间较安全。

预期收益：降低页面 payload 体积，减少移动端首屏解析压力。

## 5. 结构优化分析

### 5.1 Dashboard view model 重复

涉及位置：

- `tools/dashboard-view.mjs`
- `themes/cactus/layout/dashboard.ejs`
- `source/_data/dashboardView.json`
- `source/_data/training.json`

当前问题：

- `tools/dashboard-view.mjs` 已经生成 dashboard view model。
- `themes/cactus/layout/dashboard.ejs` 内仍保留 `buildFallbackDashboardViewModel`，并重复实现 `formatNumber`、`formatDuration`、`formatWorkoutDuration`、`addDays`、`filterChartsByDate`、`findLatestDashboardDate`、`normalizeDateValue`、`normalizeMeasurementDate`、`normalizeDayDate` 等逻辑。
- 模板同时承担数据兜底、视图模型计算、HTML 字符串渲染和页面结构输出，导致页面行为变化难以定位。

优化建议：

- 第一阶段保留模板兜底，但将 fallback 降级为最小兜底：只处理空数据或 stale `dashboardView.json` 的提示。
- 第二阶段让 `tools/dashboard-view.mjs` 成为 dashboard 派生数据唯一来源。
- 第三阶段把 `dashboard.ejs` 中的 metric/render helper 进一步组件化或局部化，减少单模板复杂度。

风险等级：中。模板回退逻辑可能是为旧数据或生成文件 stale 场景服务，移除前必须覆盖 `test/dashboard-page.test.mjs` 中 stale data 场景。

预期收益：消除最明显重复逻辑，避免 dashboard 生成态与运行态口径不一致。

### 5.2 数据库核心模块拆分

涉及位置：

- `tools/training-db-core.mjs`
- `tools/training-db-archive.mjs`
- `tools/backfill-training-core-from-archive.mjs`
- `tools/import-training-markdown.mjs`
- `tools/export-training-markdown.mjs`
- `tools/reconcile-training-markdown-to-core.mjs`

当前问题：

- `tools/training-db-core.mjs` 对外提供多个高层能力，同时包含大量底层 SQL 与数据映射。
- `tools/training-db-archive.mjs` 与 core 模块存在配置解析、client 创建、正整数解析等相似模式。
- 导入、导出、reconcile、backfill 脚本已经很薄，核心复杂度都压在 DB 模块内部。

优化建议：

- 拆分建议边界：
  - `training-db-config`：解析 env、创建 client。
  - `training-db-read`：读取 core/archive snapshot。
  - `training-db-write`：persist batch、replace day。
  - `training-db-export`：snapshot 到 Markdown 文本。
  - `training-db-merge`：batch 与 existing day 合并。
- 保持现有 `tools/training-db-core.mjs` 作为兼容 facade，继续导出原函数，降低调用方改动。

风险等级：中高。拆分本身不应改变行为，但 SQL 与事务边界容易被误改。

预期收益：降低数据库层维护成本，方便后续做查询合并和批量写入优化。

### 5.3 Telegram 模块拆分

涉及位置：

- `tools/telegram-sync.mjs`
- `tools/telegram-sync-lib.mjs`
- `cloudflare/telegram-sync-dispatch-worker.mjs`
- `prompts/telegram-training-image-recognition.md`
- `docs/telegram-date-resolution.md`
- `docs/telegram-recognition-prompt.md`

当前问题：

- `cloudflare/telegram-sync-dispatch-worker.mjs` 边界清楚，负责 webhook 转发和 album buffer。
- Node 侧 Telegram sync 被拆为 runner 与 lib，但 lib 内部仍然聚合太多领域细节。
- prompt 文档、日期解析文档和实际代码之间存在行为耦合，后续修改需要同步更新测试与文档。

优化建议：

- 保持 Cloudflare Worker 独立，不与 Node 同步逻辑混合。
- 将 Node 侧拆成三层：transport/input、domain analysis、persistence/output。
- 日期解析规则变更必须同时更新 `docs/telegram-date-resolution.md` 和 `test/telegram-sync.test.mjs`。
- prompt 变更必须优先更新 `prompts/telegram-training-image-recognition.md`，再验证识别结果归一化。

风险等级：中。Telegram 数据是外部输入，边界处理必须稳定。

预期收益：新增消息类型、识别字段或归档规则时更容易定位影响范围。

### 5.4 Parser 与 domain 边界

涉及位置：

- `tools/training-parser.mjs`
- `tools/training-domain.mjs`
- `tools/training-snapshot.mjs`

当前问题：

- `training-parser` 聚焦 Markdown 到 canonical daily，职责清晰。
- `training-domain` 包含 section split、数值解析、活动汇总、snapshot 构建，整体仍可维护。
- `training-snapshot` 负责 source 选择与 fallback 错误分类，体量较小。

优化建议：

- 该区域暂不作为第一阶段重构重点。
- 可在后续把通用日期、数值格式化工具与 dashboard/telegram 重复逻辑统一。
- 保持 parser 输出 schema 稳定，避免影响 DB import/export 和 dashboard。

风险等级：低到中。parser 是数据入口之一，但当前模块边界比 DB 和 Telegram 更清晰。

预期收益：有限，建议排在 dashboard 重复逻辑和大文件拆分之后。

## 6. 冗余清理分析

### 6.1 运行态与生成物

涉及位置：

- `public/`
- `source/_data/training.json`
- `source/_data/dashboardView.json`
- `训练数据解析.md`
- `db.json`
- `telegram/state.json`
- `telegram/process-log.ndjson`
- `telegram/inbox/*.ndjson`
- `runtime/`

当前发现：

- `.gitignore` 已忽略 `public/`、`source/_data/training.json`、`source/_data/dashboardView.json`、`训练数据解析.md`、`runtime/`、`telegram/state.json`、`telegram/process-log.ndjson`、`telegram/inbox/`。
- 当前 `git ls-files` 显示 `telegram/state.json`、`telegram/process-log.ndjson` 和多个 `telegram/inbox/*.ndjson` 仍然被版本跟踪。
- `public/` 当前在工作区存在但未被 `git ls-files` 跟踪，符合生成物定位。
- `source/_data/*.json` 当前工作区存在但未被跟踪，符合构建产物定位。

优化建议：

- 明确 `telegram/inbox/*.ndjson` 的身份：如果是测试夹具，建议迁移到 `test/fixtures/telegram/`；如果是运行态数据，建议从版本库移除跟踪。
- `telegram/state.json` 和 `telegram/process-log.ndjson` 更像运行态文件，建议后续移出版本管理。
- `source/_data/*.json` 和 `训练数据解析.md` 继续保持生成物，不建议提交。
- `public/` 继续保持 GitHub Pages artifact 输出，不建议提交。

风险等级：中。清理已跟踪运行态文件可能影响既有测试或调试流程，删除前需确认没有测试直接依赖这些具体文件。

预期收益：减少仓库噪音，降低误提交运行态数据的概率。

### 6.2 主题资源

涉及位置：

- `themes/cactus/languages/*.yml`
- `themes/cactus/source/css/_highlight/*`
- `themes/cactus/source/lib/font-awesome/`
- `themes/cactus/source/lib/meslo-LG/`
- `themes/cactus/source/lib/vazir-font/`
- `themes/cactus/source/lib/jquery/`
- `themes/cactus/source/lib/clipboard/`
- `themes/cactus/source/lib/justified-gallery/`

当前发现：

- 主题目录保留了 Cactus 原主题的多语言、字体、高亮主题和第三方库。
- 当前站点语言是 `zh-CN`，主要页面是 dashboard、thoughts、about。
- 主题资源体积较大，但其中部分可能由主题配置、样式 import 或模板条件引用。

优化建议：

- 不建议第一阶段直接删除主题资源。
- 先通过构建产物与模板引用确认实际使用范围。
- 如果后续清理，应优先清理未引用语言文件和未启用高亮主题，而不是字体或核心 JS 库。
- 对第三方库清理需验证 Hexo 页面、文章页、搜索、gallery、clipboard 等主题能力是否仍要求保留。

风险等级：中。主题资源看似冗余，但误删会造成页面样式、字体或功能缺失。

预期收益：减少仓库体积与主题维护噪音。

### 6.3 测试与文档残留

涉及位置：

- `test/*.mjs`
- `docs/*.md`
- `prompts/*.md`

当前发现：

- 测试文件体量较大，但覆盖了当前复杂链路，是重构安全网，不应作为冗余清理对象。
- `docs/telegram-date-resolution.md`、`docs/telegram-recognition-prompt.md`、`docs/thoughts-module.md` 与当前代码行为强相关，应保留。
- `prompts/telegram-training-image-recognition.md` 是 AI 识别链路的输入约束，应保留。

优化建议：

- 测试可按领域拆分和增加 fixtures，但不建议减少覆盖。
- 文档可在后续重构完成后更新，不建议提前删除。

风险等级：低。

预期收益：通过整理而非删除提升可读性。

## 7. 配置与环境分析

### 7.1 npm scripts

涉及位置：

- `package.json`

当前脚本分为：

- 数据生成：`build:data`
- core 回填：`backfill:core`
- Markdown 导入导出：`import:markdown`、`export:markdown`、`reconcile:markdown`
- Hexo 构建：`build:site`、`build`、`clean`、`server`
- Telegram 同步：`sync:telegram`、`telegram:sync`

优化建议：

- 当前命名基本清晰。
- `sync:telegram` 与 `telegram:sync` 是别名关系，可保留兼容；如需清理，应先确认 workflow 和文档引用。
- 不建议在本轮改变任何脚本名。

### 7.2 GitHub Actions

涉及位置：

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/telegram-sync.yml`
- `.github/workflows/deploy-cloudflare-worker.yml`

当前问题：

- `deploy-pages.yml` 与 `telegram-sync.yml` 都包含 Node 22 setup、`npm ci`、DB 环境变量、backfill/reconcile 等步骤。
- `telegram-sync.yml` 在 `repository_dispatch` 快速路径下跳过 backfill/reconcile/export，符合当前文档描述。

优化建议：

- 短期不改 workflow，避免影响自动同步。
- 中期可把重复 env 名称和步骤整理到文档 checklist，或使用 composite action 复用。
- workflow 优化必须保留 repository_dispatch 快速路径差异。

风险等级：中。CI/CD 改动影响自动发布和 Telegram 同步。

## 8. 后续重构路线

### 阶段 1：低风险清理与文档固化

目标：

- 不改代码行为，先降低仓库噪音和决策不确定性。

建议任务：

- 标记 `telegram/inbox/*.ndjson`、`telegram/state.json`、`telegram/process-log.ndjson` 的身份，决定是否迁移到 `test/fixtures/` 或移出版本跟踪。
- 补充生成物与运行态文件说明，明确 `source/_data/*.json`、`public/`、`训练数据解析.md` 不应提交。
- 在 docs 中记录 dashboard view model 的唯一来源目标。

验证：

- `git status --short`
- `npm test`

### 阶段 2：重复逻辑抽取

目标：

- 先处理最明确的重复逻辑，降低未来行为漂移。

建议任务：

- 收敛 `tools/dashboard-view.mjs` 与 `themes/cactus/layout/dashboard.ejs` 的重复 view model 派生逻辑。
- 保持 `test/dashboard-view.test.mjs` 与 `test/dashboard-page.test.mjs` 全部通过。
- 抽取通用格式化/日期规范化工具时，不改变 JSON 输出格式。

验证：

- `npm test -- test/dashboard-view.test.mjs test/dashboard-page.test.mjs`
- `npm run build`

### 阶段 3：大文件拆分

目标：

- 在 facade 保持兼容的前提下拆分核心大文件。

建议任务：

- 拆分 `tools/training-db-core.mjs`，保留原导出。
- 拆分 `tools/telegram-sync-lib.mjs` 的日期解析、Markdown 渲染和 batch 分析。
- 拆分 `tools/telegram-sync.mjs` 的 pending queue、thought post writer、AI client、Telegram API client。

验证：

- `npm test`
- `npm run build`
- 人工检查 `git diff` 中没有 CLI、schema、workflow 行为变更。

### 阶段 4：性能优化

目标：

- 在结构边界清楚后再优化查询、写入和 IO。

建议任务：

- 同一同步批次内按 `archivedDate` 聚合 ready batches，减少重复读取与整日替换。
- 对 database snapshot 构建评估批量查询或 SQL 聚合。
- 延迟读取 Markdown，仅在 fallback、archive 或 rebuild 确实需要时触发。
- 为 pending queue 增加异常行处理与增长治理策略。

验证：

- `npm test`
- `npm run build`
- 使用真实或脱敏 Telegram fixture 跑同步 dry-run/模拟测试。

## 9. 风险与约束

- 不改变 `TrainingSnapshot`、`dashboardView.json`、Telegram batch result、Markdown 导出格式等事实上的公共接口。
- 不改变 PostgreSQL `core.*`、`archive.*` schema。
- 不改变 `TRAINING_SNAPSHOT_SOURCE`、`TRAINING_DB_*`、`TELEGRAM_*`、`AI_*` 等环境变量语义。
- 不改变 Telegram `/thought` 当前写入 `source/_posts/*.md` 的行为。
- 不改变 PostgreSQL 失败时 Markdown fallback 与 pending queue 补偿机制。
- 不把测试覆盖视为冗余；当前测试是后续重构能否安全推进的核心保障。

## 10. 推荐优先级

| 顺序 | 建议事项 | 原因 |
| --- | --- | --- |
| 1 | 统一 dashboard view model 来源 | 重复最明显，收益高，风险可由现有 dashboard 测试覆盖 |
| 2 | 明确并清理 Telegram 运行态跟踪文件 | 仓库噪音明显，且 `.gitignore` 已表达不应继续跟踪 |
| 3 | 拆分 `tools/training-db-core.mjs` | 数据库层复杂度最高，是后续性能优化前置条件 |
| 4 | 拆分 `tools/telegram-sync-lib.mjs` | 日期解析和 Markdown 渲染需要更清晰边界 |
| 5 | 拆分 `tools/telegram-sync.mjs` | 主流程副作用多，拆分后更容易维护 |
| 6 | 优化 DB 查询与 Markdown IO | 应在结构边界稳定后执行，避免边重构边调性能导致风险叠加 |

## 11. 结论

当前系统的功能链路已经相对完整，测试覆盖也为后续优化提供了较好的安全基础。最值得优先处理的问题不是单点性能瓶颈，而是核心逻辑集中在少数大文件、dashboard view model 重复实现、以及部分运行态文件仍被版本跟踪。

建议后续重构采用“小步、可回滚、接口不变”的方式推进：先清理边界和重复逻辑，再拆分大文件，最后做数据库与 IO 性能优化。这样可以最大限度保持现有功能与数据获取方式完全一致，同时逐步降低系统维护成本。
