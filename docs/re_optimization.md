# 系统重构与优化执行总文档

本文档是后续重构的总入口，目标是让程序员可以按阶段改造系统，而不是重新阅读一份长篇审计报告。当前阶段只规划内部结构、CI、Prompt 和文档治理，不新增用户可见功能。

## 1. 重构目标与不可变约束

### 1.1 目标

- **功能不变**：训练记录导入、Telegram 同步、随想、训练分析、Dashboard、Markdown fallback、GitHub Pages 发布行为保持一致。
- **Telegram 同步更快**：优先优化 `repository_dispatch` 快速路径，减少无内容变更时的 CI 等待时间。
- **内部接口稳定**：抽出面向未来服务器迁移的 service/facade，不在本阶段新增 HTTP API。
- **更方便维护**：减少大文件职责、重复 view model、重复 workflow 配置和运行态文件噪音。
- **Prompt 准确优先**：压缩重复说明、降低 token 消耗，但不牺牲日期、单位、空值、置信度和数据入库准确性。
- **文档更直观**：形成“一个总入口 + 少量单一事实来源文档”的维护结构，避免同一规则多处复制。

### 1.2 不可变约束

后续任何阶段都不得在未明确说明和单独验证前改变以下内容：

- 不改变 PostgreSQL `core.*`、`archive.*` schema。
- 不改变 `TrainingSnapshot`、`dashboardView.json`、Markdown 导出文本、Telegram batch result 的现有语义。
- 不改变 `TRAINING_SNAPSHOT_SOURCE`、`TRAINING_DB_*`、`TELEGRAM_*`、`AI_*` 等环境变量语义。
- 不改变 `npm run build`、`npm run sync:telegram`、`npm run export:markdown` 等现有 CLI 用法。
- 不改变 PostgreSQL 不可用时的 Markdown fallback 与 pending queue 补偿机制。
- 不改变 `/thought` 写入 `source/_posts/*.md`、`/analysis` 只回 Telegram 不写仓库的行为。
- 不把测试覆盖视为冗余。测试是重构安全网，只能整理和补充，不能为了“清理”减少关键覆盖。

## 2. 当前代码事实

### 2.1 系统边界

当前项目是 Hexo 静态站点 + Node.js 数据工具链，主要链路如下：

- `训练记录.md`：人工可读记录，也是数据库不可用时的重要 fallback。
- PostgreSQL `core.*`：Telegram 自动同步后的主结构化数据层。
- PostgreSQL `archive.*`：Markdown 解析快照与历史归档层。
- Telegram webhook / polling：接收训练截图、文档图片、`/thought`、`/analysis`。
- `source/_data/training.json` 与 `source/_data/dashboardView.json`：Hexo 构建时生成，供页面渲染使用。
- Cloudflare Worker：接 Telegram webhook，聚合相册消息后触发 GitHub `repository_dispatch`。

### 2.2 主要维护压力

| 区域 | 当前问题 | 后续方向 |
| --- | --- | --- |
| `themes/cactus/layout/dashboard.ejs` | 模板内仍有大量 view model 派生、fallback 和 comparison 逻辑 | 让 `tools/dashboard-view.mjs` 成为唯一派生入口，EJS 只渲染 |
| `tools/training-db-core.mjs` | 单文件承担配置、连接、读取、写入、导出、merge、backfill | 拆成 DB service 组件，保留原 facade 导出 |
| `tools/telegram-sync-lib.mjs` | batch 分析、日期解析、Markdown 渲染、fingerprint、thought 命令混在一起 | 按纯函数领域拆分，保持外部导出兼容 |
| `tools/telegram-sync.mjs` | CLI、env、Telegram API、AI、pending queue、DB、Markdown、报告都在主流程中 | 拆出 transport、AI client、queue、writer、orchestrator |
| `.github/workflows/*.yml` | Node setup、`npm ci`、DB env、build/deploy 步骤重复 | 优先优化 Telegram 快速同步链路，再整理复用 |
| `prompts/*.md` 与 analysis 请求体 | Prompt 文本有压缩空间，`/analysis` 发送 pretty JSON 消耗较多 token | 准确优先压缩 prompt 和 payload |
| `docs/*.md` | 多份文档有背景和规则重复 | 总入口索引 + 单一事实来源 |
| `telegram/` 运行态文件 | `.gitignore` 已忽略，但历史文件仍被跟踪 | 明确 fixture/运行态身份后移出版本跟踪 |

### 2.3 当前测试安全网

核心测试覆盖集中在以下文件：

- Telegram 同步：`test/telegram-sync.test.mjs`、`test/telegram-sync-runner.test.mjs`、`test/telegram-sync-dispatch-worker.test.mjs`
- DB 与 snapshot：`test/training-db-core.test.mjs`、`test/training-db-archive.test.mjs`、`test/training-snapshot.test.mjs`
- Dashboard：`test/dashboard-view.test.mjs`、`test/dashboard-page.test.mjs`
- Prompt/analysis：`test/training-analysis.test.mjs`
- Workflow：`test/github-workflows.test.mjs`

已知注意点：`test/github-workflows.test.mjs` 目前偏文本匹配，后续 workflow 改造前应先修复换行符兼容问题，再补充关键路径断言。

## 3. 目标内部接口

本阶段“开放接口”指内部 service/facade，不新增 HTTP API。原则是先把业务边界抽稳，未来迁移到服务器时再把这些 service 映射成 HTTP 或队列消费入口。

### 3.1 Training Snapshot Service

目标：统一训练数据快照读取入口。

建议职责：

- 根据 `TRAINING_SNAPSHOT_SOURCE` 从 Markdown 或 database 构建 `TrainingSnapshot`。
- 保留 database 不可用时的现有 fallback 行为。
- 统一 snapshot source、错误分类、生成时间、latest/daily 输出口径。
- 对外提供稳定内部接口，例如 `buildTrainingSnapshot(options)`。

兼容要求：

- 保留 `tools/training-snapshot.mjs` 当前导出。
- 不改变 `TrainingSnapshot` JSON 结构。
- 不改变 `generate-training-data`、`training-analysis`、`export:markdown` 的调用语义。

### 3.2 Training Persistence Service

目标：把 core/archive 的读写、导出、reconcile、backfill 统一收束。

建议职责：

- `config/client`：解析 DB env、创建 client、统一 timeout/app name。
- `snapshot reader`：读取 `core.*` 和 `archive.*` snapshot。
- `batch writer`：持久化 Telegram normalized batch，维护 update id。
- `day merger`：合并同一天多来源数据，保持当前覆盖规则。
- `markdown exporter`：从 snapshot 导出 `训练记录.md` 文本。
- `archive writer`：保留 archive snapshot 和失败日志。

兼容要求：

- `tools/training-db-core.mjs` 继续作为 facade 导出现有函数。
- `tools/training-db-archive.mjs` 独立性较好，优先级低于 core 拆分。
- 拆分阶段不改 SQL schema、不改事务语义、不改 Markdown 导出格式。

### 3.3 Telegram Sync Service

目标：让 Telegram 同步主流程可读、可测、可替换。

建议分层：

- `transport/input`：Telegram polling、repository_dispatch event、Cloudflare webhook 输入。
- `batch analysis`：update 分组、允许 chat 校验、图片/文档/随想/分析命令分类。
- `AI recognition`：图片识别 prompt、schema、并发、结果解析。
- `persistence/output`：DB 写入、Markdown fallback、thought post writer、pending queue、report。
- `telegram reply`：`/analysis` 回复与错误消息发送。

兼容要求：

- 保留 `runTelegramSync(options)`、`loadRecognitionSystemPrompt(env)`、`buildTelegramSyncReport(result)` 等当前测试依赖的导出。
- Cloudflare Worker 保持独立，不与 Node 同步逻辑强耦合。
- `repository_dispatch` 快速路径继续跳过 backfill/reconcile/export。

### 3.4 Dashboard View Service

目标：`tools/dashboard-view.mjs` 成为 dashboard 派生数据唯一来源。

建议职责：

- 在生成阶段预计算 dashboard 所需 view model。
- 每个 `dailyOverviewEntry` 预计算 comparison、训练时长、趋势、图表过滤所需字段。
- EJS 模板只做 HTML 渲染和极小兜底，不再重复日期规范化、区间过滤、comparison 计算。

兼容要求：

- `source/_data/dashboardView.json` 可以新增向后兼容字段，但不得移除当前页面依赖字段。
- `test/dashboard-view.test.mjs` 和 `test/dashboard-page.test.mjs` 必须覆盖 stale data 和新字段。

## 4. GitHub Actions 优化方案

优先目标是 Telegram `repository_dispatch` 快速同步，而不是一次性重写全部 CI。

### 4.1 当前路径

- `deploy-pages.yml`：push 到 main 后构建和发布 GitHub Pages。
- `telegram-sync.yml`：手动、`训练记录.md` push、`repository_dispatch` 触发 Telegram 同步。
- `deploy-cloudflare-worker.yml`：只在 Worker 相关文件变化时部署。

### 4.2 快速路径原则

- `repository_dispatch` 继续跳过 backfill、reconcile、export。
- 如果 Telegram 同步没有产生 `训练记录.md`、`source/_posts`、`source/images` 变化，应快速结束，不运行测试、不部署。
- 只有内容变更时才运行必要测试、commit、push、build、deploy。
- 避免 sync job 和 deploy job 重复 `checkout`、`setup-node`、`npm ci`。可评估在同一 job 内完成 build/deploy，或通过 artifact 传递构建产物。
- `npm ci` 使用 `actions/setup-node` cache 继续保留。不要引入会改变 lockfile 或依赖安装语义的优化。

### 4.3 分阶段改造建议

1. 修复 `test/github-workflows.test.mjs` 的换行符兼容问题，并补充 repository_dispatch 快速路径断言。
2. 整理 `telegram-sync.yml`：确认无变化路径不测试、不构建、不部署。
3. 合并 Telegram sync 后的 deploy 重复步骤，目标是减少第二次 `npm ci`。
4. 对 `deploy-pages.yml` 与 `telegram-sync.yml` 的 DB env、Node setup、build step 做复用整理。可以使用 composite action，但不要为了复用牺牲可读性。

### 4.4 验收

- `node --test test/github-workflows.test.mjs`
- 手动触发 `workflow_dispatch`。
- 用 `repository_dispatch` 验证图片/随想同步。
- 验证无内容变更时 workflow 快速结束。
- 验证内容变更时仍能 commit、push、build、deploy。

## 5. Prompt 与 AI 请求优化方案

Prompt 优化采用准确优先策略：降低 token 是目标之一，但不能以误识别日期、单位或错误入库为代价。

### 5.1 图片识别 Prompt

单一事实来源：`prompts/telegram-training-image-recognition.md`。

优化方向：

- 压缩重复表述，保留强约束：输出 JSON、schema 字段、日期来源、单位换算、空值、confidence、warnings。
- 日期规则必须继续强调：`detectedDate` 只来自截图内可靠日期；caption/text/文件名不由 AI 推断，交给程序后处理。
- 单位规则必须继续保留：斤转 kg、百分比只输出数字、无法可靠识别填 `null`。
- 低置信度策略必须继续保留：低于阈值结果会被系统跳过，不确定时降低 confidence 并写 warnings。
- 不在 prompt 中改 schema 字段名；新增字段必须同步 schema、归一化、DB/Markdown 写入和测试。

验收：

- `node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs`
- 用历史截图样例或脱敏样例对比识别 JSON，日期和数值准确率不得倒退。

### 5.2 `/analysis` Prompt 与请求体

单一事实来源：`prompts/training-analysis.md`。

优化方向：

- 保留固定四段输出、时间窗约束、长期目标、缺失数据不编造、非医疗诊断等核心规则。
- 压缩重复建议口径，减少泛化训练常识，把空间留给当前数据约束。
- `tools/training-analysis.mjs` 中发送给模型的 `focus` 和 `summary` 不再使用 pretty JSON；改为紧凑 JSON 或更短字段名摘要。
- 只发送回答当前问题必要的窗口数据。用户问 7 天时，不把 30 天摘要作为主输入；需要长期背景时再附带精简字段。
- 保留 `TRAINING_ANALYSIS_PROMPT_PATH` 作为实验入口。

验收：

- `node --test test/training-analysis.test.mjs`
- 验证最近 7 天、最近 30 天、今天/明天训练建议、缺失数据场景。
- Telegram 回复仍为纯文本，仍包含：数据结论、恢复风险、饮食观察、下一步行动。

## 6. 文档合并与维护方案

文档治理目标不是把所有内容塞进一个超长文件，而是让每类规则只有一个维护位置。

### 6.1 总入口

`docs/re_optimization.md` 是重构总入口，只保留：

- 当前目标与不可变约束。
- 目标内部接口。
- CI、Prompt、文档治理的改造方向。
- 分阶段路线。
- 验收测试。

不在本文复制长篇领域规则，避免后续改一处忘三处。

### 6.2 单一事实来源

| 规则类型 | 单一事实来源 | 本文处理方式 |
| --- | --- | --- |
| Telegram 日期归档规则 | `docs/telegram-date-resolution.md` | 只引用，不复制完整规则 |
| 图片识别 prompt 维护规则 | `docs/telegram-recognition-prompt.md` + `prompts/telegram-training-image-recognition.md` | 只记录优化方向 |
| `/analysis` 行为 | `docs/telegram-analysis.md` + `prompts/training-analysis.md` | 只记录接口和 token 优化方向 |
| `/thought` 行为 | `docs/thoughts-module.md` | 只记录不可变约束 |
| GitHub secrets/vars | `docs/github-settings.md` | 只记录 CI 优化影响 |
| Cloudflare webhook | `docs/telegram-webhook-cloudflare.md` | 只记录 Worker 独立边界 |
| Dashboard 派生数据 | `tools/dashboard-view.mjs` 与对应测试 | 本文记录重构目标 |

### 6.3 合并规则

- 删除或合并纯历史背景、重复概念解释、已经过期的“当前发现”。
- 领域文档只保留本领域的规则和验证方法。
- 总文档只写“做什么、为什么、怎么验收”，不复制长规则。
- 新增行为时先更新单一事实来源，再在本文的路线或约束中添加链接式说明。

## 7. 分阶段改造路线

### Phase 1：文档固化与低风险清理

目标：让后续改造有清晰边界，不改变运行行为。

任务：

- 保持本文作为重构总入口。
- 确认各领域文档的单一事实来源边界。
- 标记 `telegram/inbox/*.ndjson`、`telegram/state.json`、`telegram/process-log.ndjson` 的身份；若是运行态文件，使用 `git rm --cached` 移出版本跟踪并保留本地文件。
- 修复 `test/github-workflows.test.mjs` 换行符兼容问题。

验收：

- `git status --short`
- `npm test`

### Phase 2：Telegram 快速同步 CI 优化

目标：优先降低 Telegram webhook 到同步完成的等待时间。

任务：

- 保留 repository_dispatch 跳过 backfill/reconcile/export 的现有差异。
- 无内容变更时跳过测试、commit、build、deploy。
- 内容变更时减少重复 checkout/setup/npm ci。
- 补充 workflow 测试覆盖快速路径。

验收：

- `node --test test/github-workflows.test.mjs`
- 手动触发 `workflow_dispatch`
- 用 `repository_dispatch` 验证有变更和无变更两种路径。

### Phase 3：Dashboard view model 收敛

目标：消除 dashboard 生成阶段和模板阶段的重复派生逻辑。

任务：

- 扩展 `buildDashboardViewModel` 输出，让 `dailyOverviewEntry` 包含模板所需 comparison 和训练时长字段。
- EJS 删除重复日期规范化、图表过滤、comparison 计算等逻辑。
- 保留 stale data 的最小兜底显示。

验收：

- `node --test test/dashboard-view.test.mjs test/dashboard-page.test.mjs`
- `npm run build`

### Phase 4：DB 与 Telegram 大文件拆分

目标：在 facade 兼容前提下降低核心模块复杂度。

任务：

- 拆分 `training-db-core` 内部 config/read/write/merge/export 职责，保留原文件导出。
- 拆分 `telegram-sync-lib` 的日期解析、batch 分析、Markdown 渲染、fingerprint、thought 命令解析。
- 拆分 `telegram-sync` 的 env、Telegram API、AI client、pending queue、thought writer、report。

验收：

- `npm test`
- `npm run build`
- 人工检查 diff：无 schema、CLI、env、Markdown 格式变化。

### Phase 5：Prompt 与 token 优化

目标：降低 AI 请求 token，同时维持或提高数据准确性。

任务：

- 精简图片识别 prompt 的重复表述。
- 精简 `/analysis` prompt 和请求体，去掉 pretty JSON 或不必要窗口数据。
- 保留 prompt path override，支持实验版本。

验收：

- `node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs test/training-analysis.test.mjs`
- 历史截图/脱敏样例对比，关键字段准确率不得倒退。

### Phase 6：结构稳定后的性能优化

目标：在边界清楚后再做 DB 查询、写入和 IO 优化。

任务：

- 同一同步批次内按 `archivedDate` 聚合 ready batch，减少重复读取与整日替换。
- 评估 snapshot 读取的批量查询或 SQL aggregation。
- 延迟读取 Markdown，仅在 fallback、archive 或 rebuild 确实需要时触发。
- 为 pending queue 增加异常行处理和增长治理策略。

验收：

- `npm test`
- `npm run build`
- 使用真实或脱敏 Telegram fixture 跑模拟同步。

## 8. 通用验收清单

每个阶段完成后至少检查：

- 功能行为是否保持一致。
- 现有 CLI、env、schema、Markdown 格式是否未变化。
- 新增内部接口是否有 facade 兼容层。
- 是否补充或更新对应测试。
- 是否避免把同一规则复制到多个文档。
- `npm test` 和必要的局部测试是否通过。
- 涉及构建或页面时，`npm run build` 是否通过。

## 9. 推荐实施顺序

1. 文档固化与运行态文件清理。
2. Telegram Sync workflow 快速路径优化。
3. Dashboard view model 单一来源。
4. `training-db-core` facade 拆分。
5. `telegram-sync-lib` 与 `telegram-sync` 分层拆分。
6. Prompt 与 `/analysis` payload token 优化。
7. DB 查询、批量写入、Markdown IO 性能优化。

这样推进可以先拿到低风险收益，再处理高耦合模块，最后基于更清晰的结构做性能优化。
