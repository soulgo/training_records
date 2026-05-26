# 系统 MCP 化改造方案设计

> 归档说明：本文是 MCP 化阶段方案和设计记录，不是日常操作手册。当前 MCP 使用方式以 [MCP 使用说明](../部署维护/MCP使用说明.md) 为准。

## 1. 当前系统架构分析

当前项目是一个以 `TrainingSnapshot` 为统一中间层的训练记录系统。核心输入来自 `训练记录.md`、Telegram 消息/图片和 PostgreSQL `core.*`，核心输出是 `source/_data/training.json`、`source/_data/dashboardView.json` 和 Hexo 生成的 `public/` 静态站点。

主要目录职责如下：

| 路径 | 当前职责 | 架构层级 |
| --- | --- | --- |
| `训练记录.md` | 人工训练记录，数据库失败时的回退写入点 | 数据层 / 回退层 |
| `tools/training-parser.mjs` | Markdown 解析为 `TrainingSnapshot` | 数据适配层 |
| `tools/training-snapshot.mjs` | 按 `TRAINING_SNAPSHOT_SOURCE` 从 Markdown 或 DB 构建快照 | 业务聚合层 |
| `tools/training-db-*.mjs` | PostgreSQL `core.* / ingest.* / archive.*` 读写 | 数据层 |
| `tools/dashboard-view.mjs` | 从快照生成首页视图模型 | 展示适配层 |
| `tools/generate-training-data.mjs` | 生成 Hexo 数据文件和解析调试文档 | 构建编排层 |
| `tools/telegram-sync.mjs` | Telegram 同步主入口，处理图片识别、随想、分析、DB 写入和回退 | 调度 / 集成层 |
| `tools/telegram-sync-lib.mjs` | Telegram update 分组、批次归一、Markdown 合并 | 业务规则层 |
| `tools/training-analysis.mjs` | 基于快照生成训练分析摘要并调用 AI | AI 服务层 |
| `src/ai/*` | AI provider、OpenAI-compatible adapter、schema 校验 | 外部模型适配层 |
| `src/telegram/command-registry.mjs` | Telegram 命令声明式 registry | 命令路由层 |
| `src/mcp/*` | MCP Tool facade 和 stdio JSON-RPC Server | Agent 工具层 |
| `cloudflare/telegram-sync-dispatch-worker.mjs` | Telegram webhook 转 GitHub repository_dispatch | 边缘入口层 |
| `themes/cactus/*` | Hexo 页面模板、样式、前端图表 | 展示层 |
| `.github/workflows/*` | CI、Pages 部署、Telegram 同步、Worker 部署 | 调度 / 发布层 |
| `sql/training_records/*` | PostgreSQL schema | 数据模型层 |
| `runtime/*.ndjson` | 待补偿队列、归档失败日志 | 运行时缓存 / 补偿层 |

当前数据流：

1. `训练记录.md` 或 PostgreSQL `core.*` 经 `tools/training-snapshot.mjs` 统一为 `TrainingSnapshot`。
2. `tools/generate-training-data.mjs` 写出 `source/_data/training.json` 和 `source/_data/dashboardView.json`。
3. Hexo 通过 `_config.yml`、`source/`、`themes/cactus/` 生成 `public/`。
4. `.github/actions/site-build/action.yml` 在 GitHub Actions 中复用构建、测试和 Pages 部署流程。
5. Telegram webhook 由 `cloudflare/telegram-sync-dispatch-worker.mjs` 转成 `repository_dispatch`。
6. `.github/workflows/telegram-sync.yml` 执行 `npm run sync:telegram`，由 `tools/telegram-sync.mjs` 处理 Telegram update。
7. 图片批次经 `src/ai/recognition-service.mjs` 调用 AI 识别，再由 `tools/training-db-write.mjs` 优先写 PostgreSQL。
8. PostgreSQL 失败时，训练数据回退写 `训练记录.md`，失败批次进入 `runtime/telegram-sync-pending.ndjson`。
9. `/analysis` 只读取快照并回发 Telegram，不写 Markdown、docs 或数据库。
10. MCP v1 通过 `src/mcp/tools.mjs` 复用快照、看板、分析摘要和命令注册表能力，对 Agent 暴露只读/分析工具。

当前配置流：

- Hexo 配置来自 `_config.yml` 和 `themes/cactus/_config.yml`。
- 数据源由 `TRAINING_SNAPSHOT_SOURCE` 控制，支持 `markdown` 和 `database`。
- PostgreSQL 由 `TRAINING_DB_ENABLED`、`TRAINING_DB_URL`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME` 控制。
- AI 由 `AI_PROVIDER`、`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_TIMEOUT_MS`、`AI_CONCURRENCY` 控制。
- Telegram 由 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_CHAT_IDS`、`TELEGRAM_SYNC_TRANSPORT`、`TELEGRAM_POLL_LIMIT` 控制。
- Cloudflare Worker 由 `GITHUB_TOKEN`、`TELEGRAM_SECRET_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO` 控制。
- MCP v1 由 `MCP_ENABLED`、`MCP_TRANSPORT`、`MCP_READONLY`、`MCP_TOOL_TIMEOUT_MS`、`MCP_MAX_DATE_RANGE_DAYS`、`MCP_ALLOWED_TOOLS` 控制。

当前耦合问题：

- `tools/telegram-sync.mjs` 同时负责调度、AI 调用、文件写入、数据库写入、补偿队列和 Telegram 回复，不适合直接暴露为 MCP Tool。
- `tools/generate-training-data.mjs` 既读快照、写文件、写归档数据库，又输出调试文档，副作用较多。
- `TrainingSnapshot` 是较好的统一结构，但部分调用仍直接依赖 Markdown 文件路径和 GitHub Actions 环境变量。
- `source/_data/training.json` 和 `dashboardView.json` 是展示产物，不是强契约 API；Agent 直接读取会绕过权限、过滤和 trace。
- `runtime/telegram-sync-pending.ndjson` 是补偿队列，不适合作为长期事实源。

当前 AI 化阻碍：

- 历史上缺少统一工具调用返回结构、错误码、权限模型和 `trace_id`；MCP v1 已在 `src/mcp/tools.mjs` 中提供统一 envelope。
- 读能力与写能力没有显式隔离，`sync:telegram`、`import:markdown`、`export:markdown` 等命令副作用大；MCP v1 默认只开放读和分析。
- 数据查询粒度主要是全量快照，Agent 场景需要按日期、时间窗、实体类型和摘要级别获取；MCP v1 已提供结构化 slice tools。
- 现有 AI 分析面向 Telegram 文本回复，不是结构化 Agent output；MCP v1 的 `training.generate_analysis` 返回 `reply`、`summary`、`focus`。
- GitHub Actions 是异步调度入口，不能直接作为低延迟 Tool runtime。

## 2. MCP 化可行性分析

优先 MCP 化“读、汇总、分析、查询配置、生成只读结果”。谨慎 MCP 化“触发同步、导入导出、写库、写 Markdown”。暂不 MCP 化“Hexo 主题渲染、GitHub Pages 发布、Cloudflare webhook 内部转发”。

### MCP Tool 候选列表

| Tool 名称 | 当前代码位置 | 输入参数 | 输出结构 | 是否适合 | 复杂度 | 风险 | Agent 使用场景 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `training.get_snapshot` | `tools/training-snapshot.mjs`, `src/mcp/tools.mjs` | `source?`, `date_from?`, `date_to?`, `include_body_feedback?` | `TrainingSnapshot` | 已实现 | 低 | 低 | Agent 获取统一训练上下文 |
| `training.get_daily_records` | `tools/training-snapshot.mjs`, `src/mcp/tools.mjs` | `date_from?`, `date_to?`, `types?` | `{ days: TrainingDay[] }` | 已实现 | 低 | 低 | 查询最近一周训练/饮食/体脂 |
| `training.get_latest_status` | `TrainingSnapshot.latest`, `src/mcp/tools.mjs` | `source?` | `{ latestMeasurement, latestDay, bodyFeedbackLatest }` | 已实现 | 低 | 低 | 回答“我现在状态如何” |
| `training.get_measurements` | `TrainingSnapshot.daily[].measurements`, `src/mcp/tools.mjs` | `date_from?`, `date_to?`, `limit?` | `{ measurements: Measurement[] }` | 已实现 | 低 | 低 | 查询体重、体脂、骨骼肌趋势 |
| `training.get_activities` | `TrainingSnapshot.daily[].activities`, `src/mcp/tools.mjs` | `date_from?`, `date_to?`, `activity_type?`, `limit?` | `{ activities: Activity[] }` | 已实现 | 低 | 低 | 查询骑行、力量、燃脂训练记录 |
| `training.get_nutrition` | `TrainingSnapshot.daily[].nutrition`, `src/mcp/tools.mjs` | `date_from?`, `date_to?` | `{ days: [{ date, nutrition }] }` | 已实现 | 低 | 低 | 饮食复盘、热量缺口判断 |
| `training.get_body_feedback` | `tools/training-snapshot.mjs`, `core.thought`, `src/mcp/tools.mjs` | `date_from?`, `date_to?`, `keyword?`, `limit?` | `{ feedback: [] }` | 已实现 | 中 | 中 | 疼痛/恢复类 Agent 分析 |
| `training.get_dashboard_view` | `tools/dashboard-view.mjs`, `src/mcp/tools.mjs` | `date_from?`, `date_to?` | `dashboardView` | 已实现 | 低 | 低 | 让 Agent 获取图表和卡片模型 |
| `training.get_chart_data` | `TrainingSnapshot.charts`, `src/mcp/tools.mjs` | `metrics[]?`, `date_from?`, `date_to?` | `{ charts: Record<string, Point[]> }` | 已实现 | 低 | 低 | 生成趋势图、周报图表 |
| `training.get_analysis_summary` | `tools/training-analysis.mjs`, `src/mcp/tools.mjs` | `date_from?`, `date_to?` | `{ summary }` | 已实现 | 低 | 低 | 多 Agent 共享压缩上下文 |
| `training.generate_analysis` | `tools/training-analysis.mjs`, `src/mcp/tools.mjs` | `question`, `goal?`, `source?` | `{ reply, summary, focus }` | 已实现 | 中 | 中 | 教练 Agent 生成建议 |
| `training.search_records` | `训练记录.md`, `source/_posts`, `src/mcp/tools.mjs` | `query`, `date_from?`, `date_to?`, `types?` | `{ matches: [] }` | 已实现 | 中 | 中 | 搜索历史疼痛、饮食异常、训练类型 |
| `training.get_markdown_record` | `exportTrainingMarkdown`, `src/mcp/tools.mjs` | `date_from?`, `date_to?`, `source?` | `{ markdown }` | 已实现，只读 | 中 | 中 | Agent 获取人类可读记录片段 |
| `runtime.get_sync_status` | `runtime/*.ndjson`, `src/mcp/tools.mjs` | `include_recent_errors?` | `{ pendingCount, archiveFailureCount }` | 已实现 | 中 | 中 | 运维 Agent 判断同步健康度 |
| `training.get_config` | env allowlist, `src/mcp/tools.mjs` | `keys?` | `{ config }` | 已实现 | 低 | 中 | Agent 判断当前数据源和功能开关 |
| `telegram.get_command_registry` | `src/telegram/command-registry.mjs`, `src/mcp/tools.mjs` | 无 | `{ commands }` | 已实现 | 低 | 低 | 用户助手解释 Telegram 用法 |
| `training.get_prompt_metadata` | `prompts/*.md`, `src/mcp/tools.mjs` | `prompt_type` | `{ metadata }` | 已实现 | 中 | 低 | Agent 判断识别/分析版本 |
| `training.trigger_data_build` | `tools/generate-training-data.mjs` | `source?`, `dry_run?` | `{ status, outputPaths }` | 暂缓 | 中 | 高 | 需要可控副作用后再开放 |
| `training.trigger_telegram_sync` | `tools/telegram-sync.mjs` | `transport`, `updates?`, `dry_run?` | `TelegramSyncResult` | 暂缓 | 高 | 高 | 写 DB/Markdown/Telegram，需强权限 |
| `training.import_markdown` | `tools/import-training-markdown.mjs` | `markdown?`, `dry_run?` | `{ status, days }` | 暂缓 | 中 | 高 | 会覆盖 `core.*` 日期数据 |
| `training.read_recognition_cache` | `src/ai/recognition-service.mjs`, `ingest.telegram_recognition` | `file_unique_id`, `prompt_version`, `schema_version`, `model` | `{ recognition }` | 内部适合 | 中 | 中 | 调试图片识别复用 |
| `site.trigger_deploy` | `.github/actions/site-build` | `ref?` | `{ workflowRun }` | 不适合 v1 | 高 | 高 | 发布应仍交给 GitHub Actions |
| `telegram.dispatch_update` | `cloudflare/telegram-sync-dispatch-worker.mjs` | Telegram update | `{ dispatched }` | 不适合 MCP | 高 | 高 | webhook 边缘入口，不是 Agent Tool |

## 3. MCP Server 架构设计

MCP Server 放在 `src/mcp/`，不改变现有业务脚本运行语义。当前 v1 入口：

- `src/mcp/tools.mjs`：Tool Layer + Service facade。
- `src/mcp/server.mjs`：最小 stdio JSON-RPC Server，支持 `initialize`、`tools/list`、`tools/call`。
- `npm run mcp:server`：启动 stdio server。

### Tool Layer

职责：

- 注册 MCP tools。
- 做参数校验、权限校验、`trace_id` 生成、timeout 包装。
- 统一返回 `{ success, trace_id, data, error, meta }`。
- 不直接暴露写库、写 Markdown、Telegram 回发或部署触发能力。

### Service Layer

可直接复用：

- `buildTrainingSnapshot` from `tools/training-snapshot.mjs`
- `buildDashboardViewModel` from `tools/dashboard-view.mjs`
- `buildTrainingAnalysisSummary` from `tools/training-analysis.mjs`
- `generateTrainingAnalysisReply`，由 MCP wrapper 改造成结构化返回
- `getTelegramCommandRegistry` from `src/telegram/command-registry.mjs`
- `exportTrainingMarkdown(snapshot)` from `tools/training-db-core.mjs`

暂不直接暴露：

- `generateTrainingData`：当前会写文件和 archive。
- `runTelegramSync`：副作用过多。
- `persistNormalizedBatch`：写库能力需权限和幂等约束。
- `readRecognitionFromDatabaseCache`：保留为内部 cache service。

### Adapter Layer

当前 v1 的适配逻辑集中在 `src/mcp/tools.mjs`：

- SnapshotAdapter：统一调用 Markdown/DB 快照源。
- MarkdownRepository：只读读取 `训练记录.md`、`source/_posts`。
- RuntimeQueueAdapter：只读读取 `runtime/telegram-sync-pending.ndjson` 和 `runtime/training-db-sync.ndjson`。
- AiAnalysisAdapter：包装 `generateTrainingAnalysisReply`。
- ConfigAdapter：只返回 allowlist 配置，并隐藏 secret。

### Data Layer

- 主事实源：PostgreSQL `core.training_day`、`core.measurement`、`core.activity`、`core.meal`、`core.thought`。
- 回退事实源：`训练记录.md`。
- 原始/审计源：`ingest.telegram_batch`、`ingest.telegram_message`、`ingest.telegram_recognition`。
- 构建归档：`archive.*`。
- 展示产物：`source/_data/training.json`、`source/_data/dashboardView.json`。
- 运行队列：`runtime/telegram-sync-pending.ndjson`、`runtime/training-db-sync.ndjson`。

MCP v1 优先读 `TrainingSnapshot`，避免让 Tool 直接拼 SQL 输出不一致结构。

### Cache Layer

当前实现：

- `training.get_snapshot`：内存 TTL 60 秒。
- `training.get_dashboard_view`：内存 TTL 60 秒。
- `training.get_chart_data`：内存 TTL 120 秒。
- `training.get_analysis_summary`：内存 TTL 120 秒。
- `training.get_config`：内存 TTL 30 秒。

说明：

- `training.generate_analysis` 不缓存最终自然语言回复。
- `runtime.get_sync_status` 不缓存，避免运维状态滞后。
- 未来数据变更类 Tool 成功后必须清理相关缓存。

### Config Layer

MCP 配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_ENABLED` | `true` | 是否启用 MCP tool 调用 |
| `MCP_TRANSPORT` | `stdio` | 当前仅实现 stdio |
| `MCP_READONLY` | `true` | v1 保持只读/分析 |
| `MCP_TOOL_TIMEOUT_MS` | `10000` | 默认 Tool 超时 |
| `MCP_MAX_DATE_RANGE_DAYS` | `366` | 最大日期窗口 |
| `MCP_ALLOWED_TOOLS` | 空 | 逗号分隔 allowlist，空表示允许全部 v1 tools |
| `MCP_REQUIRE_AUTH` | `false` | HTTP transport 预留 |
| `MCP_LOG_LEVEL` | `info` | 日志级别预留 |

## 4. 数据与上下文设计

适合长期放入 Agent Context：

- 当前目标：`TRAINING_ANALYSIS_GOAL` 或默认“增肌减腹”。
- `buildTrainingAnalysisSummary` 产出的 recent7/recent30 摘要。
- `latestMeasurement`、`latestDay`、最近 5 天 `latestDays`。
- Telegram command registry 的命令说明。
- 当前数据源、数据覆盖范围、最近更新时间。

适合 Tool 动态获取：

- 全量 `TrainingSnapshot.daily`。
- 指定日期范围内的活动、饮食、体脂明细。
- `训练记录.md` 原文或长 Markdown 片段。
- `source/_posts` 随想全文和图片引用。
- `ingest.*` 原始识别结果和 Telegram 原始批次。
- `runtime/*.ndjson` 运行时队列。

不应长期放入 Context：

- 全量训练历史。
- Telegram 原始消息 payload。
- AI 图片识别原始 JSON。
- `训练记录.md` 全文。
- 数据库连接信息、Bot token、AI key。
- GitHub/Cloudflare tokens。
- `runtime/telegram-sync-pending.ndjson` 的完整失败 payload。

适合向量化：

- `source/_posts/*-telegram-thought-*.md` 随想正文，尤其 `thought_module=body_feedback`。
- `训练记录.md` 中按日期切分的 Markdown 区块。
- `/analysis` 历史问答，如果未来持久化。
- `docs/训练系统/Telegram使用说明.md`、`docs/训练系统/Telegram训练分析.md`、`docs/系统架构/内部接口手册.md` 可作为 Agent 使用手册。

不优先向量化：

- `TrainingSnapshot.charts` 数值序列。
- `core.measurement`、`core.activity`、`core.meal` 等结构化表。
- `dashboardView.json` 中 HTML 片段。
- `ingest.telegram_batch.batch_payload_json` 原始 payload。

## 5. MCP Tool 设计规范

### 命名规范

- 训练领域：`training.get_snapshot`、`training.get_activities`、`training.generate_analysis`
- 运行状态：`runtime.get_sync_status`
- Telegram 元信息：`telegram.get_command_registry`

命名使用小写 snake_case。v1 禁止默认开放写入类 `create/update/delete/import/sync`。

### 参数规范

通用参数：

```ts
{
  trace_id?: string;
  source?: "markdown" | "database" | "auto";
  date_from?: string;
  date_to?: string;
  limit?: number;
  include_raw?: boolean;
}
```

约束：

- 日期必须为 `YYYY-MM-DD`。
- 默认 `source=auto`，内部沿用 `TRAINING_SNAPSHOT_SOURCE`。
- 默认最大日期范围 366 天。
- `include_raw=true` 只影响搜索/原文摘要，不开放 secrets。
- 不允许 Tool 参数直接传数据库 URL、token、文件绝对路径。

### 返回结构规范

成功：

```ts
{
  success: true,
  trace_id: "mcp_20260526_xxxxx",
  data: {},
  error: null,
  meta: {
    source: "database",
    generated_at: "2026-05-26T00:00:00.000Z",
    cache: "hit" | "miss" | "disabled",
    duration_ms: 32
  }
}
```

失败：

```ts
{
  success: false,
  trace_id: "mcp_20260526_xxxxx",
  data: null,
  error: {
    code: "SNAPSHOT_UNAVAILABLE",
    message: "database snapshot unavailable",
    retryable: true,
    details: {}
  },
  meta: {
    duration_ms: 1200
  }
}
```

### 错误码规范

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数格式错误 |
| `UNAUTHORIZED` | 调用方无权限或 tool 不在 allowlist |
| `TOOL_DISABLED` | Tool 不存在或 MCP 未启用 |
| `DATABASE_UNAVAILABLE` | DB 连接或查询失败 |
| `MARKDOWN_UNAVAILABLE` | Markdown 文件不可读或解析失败 |
| `AI_PROVIDER_ERROR` | AI provider 调用失败 |
| `TIMEOUT` | Tool 超时 |
| `INTERNAL_ERROR` | 未分类内部错误 |

### 日志与 trace_id

- Tool Layer 生成 `trace_id`，格式 `mcp_<yyyymmdd>_<random>`。
- 所有 Tool 返回包含 `trace_id`。
- `training.get_config` 不返回 `AI_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TRAINING_DB_URL` 等敏感配置。

### 权限规范

当前通过 `MCP_ALLOWED_TOOLS` 实现 allowlist。v1 默认只包含读和分析类能力，未实现写类 Tool。

| 权限概念 | 当前 Tool |
| --- | --- |
| `read:snapshot` | `training.get_snapshot`, `training.get_daily_records` |
| `read:health` | `runtime.get_sync_status`, `training.get_config` |
| `read:raw` | `training.get_markdown_record`, `training.search_records` |
| `ai:analysis` | `training.generate_analysis` |

### 幂等、超时、限流

- 读 Tool 无副作用。
- `training.generate_analysis` 会调用 AI，但不写数据库、Markdown 或 Telegram。
- Tool 默认超时 `MCP_TOOL_TIMEOUT_MS=10000`。
- AI 分析实际外部请求仍受现有 `AI_TIMEOUT_MS`、provider retry 和模型服务限制。
- 当前未实现跨进程限流；部署 HTTP transport 前需要补充 per-agent rate limiter。

## 6. 迁移路径与风险

阶段 1：只读 MCP Facade，已完成。

- 新增 `src/mcp/tools.mjs` 和 `src/mcp/server.mjs`。
- 复用 `buildTrainingSnapshot`、`buildDashboardViewModel`、`buildTrainingAnalysisSummary`。
- 开放快照、明细、摘要、配置、运行状态和命令注册表查询。

阶段 2：结构化查询 Tool，已完成基础版本。

- 已增加 measurements、activities、nutrition、body_feedback、chart_data 查询。
- 当前从 `TrainingSnapshot` 裁剪，未散落新增 SQL。

阶段 3：AI 分析 Tool，已完成基础版本。

- `training.generate_analysis` 返回自然语言 `reply`，同时返回 `summary`、`focus`、`dataSource`。
- 不写 Telegram、Markdown 或数据库。

阶段 4：受控副作用 Tool，暂缓。

- 只在权限模型、dry-run、idempotency 和审计日志完成后开放。
- 候选包括 `training.trigger_data_build`、`training.export_markdown_preview`。
- 暂不开放 `training.trigger_telegram_sync` 和 `training.import_markdown` 给普通 Agent。

高风险点：

- `tools/telegram-sync.mjs` 当前副作用复杂，直接 MCP 化可能导致重复写库、重复回发 Telegram 或覆盖 Markdown。
- `importTrainingMarkdownToDatabase` 会按日期重写 `core.*`，必须强权限。
- `generateTrainingData` 当前会写 `source/_data`、`训练数据解析.md` 和 `archive.*`，不能作为只读 Tool。
- `runtime/telegram-sync-pending.ndjson` 是补偿队列，Agent 只能读状态，不应默认修改。
- `source/_data/*.json` 是展示产物，不应替代 `TrainingSnapshot` 服务契约。

## 7. 使用方式

启动 MCP stdio server：

```bash
npm run mcp:server
```

手工 JSON-RPC 示例：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"training.get_snapshot","arguments":{"source":"markdown","date_from":"2026-05-01","date_to":"2026-05-26"}}}
```

限制可调用 Tool：

```bash
MCP_ALLOWED_TOOLS=training.get_snapshot,training.get_config npm run mcp:server
```

## 8. 测试方案

已新增：

- `test/mcp-tools.test.mjs`
- `test/mcp-server.test.mjs`

覆盖内容：

- Tool catalog 不包含高副作用同步/部署工具。
- `training.get_snapshot` 支持统一 envelope 和日期窗口。
- `training.get_daily_records` 支持按类型投影。
- measurements、activities、config、runtime status、search、command registry、analysis wrapper。
- 参数错误返回 `success=false` 和结构化错误。
- JSON-RPC handler 支持 `tools/list`、`tools/call` 和 method error。

建议回归命令：

```bash
node --test test/mcp-tools.test.mjs test/mcp-server.test.mjs
node --test test/telegram-sync.test.mjs test/training-analysis.test.mjs test/training-db-core.test.mjs test/dashboard-view.test.mjs
npm test
```

## 9. 默认假设

- MCP v1 以只读能力和 AI 分析能力为主，不开放直接写库、写 Markdown、发 Telegram、触发 Pages 部署。
- `TrainingSnapshot` 继续作为系统对 Agent 的主数据契约。
- PostgreSQL `core.*` 是未来 SaaS 化的主结构化数据层，`训练记录.md` 保留为人工可读和故障回退层。
- GitHub Actions 仍负责 CI、构建和发布；MCP Server 不直接替代部署流程。
- Cloudflare Worker 仍只作为 Telegram webhook 转发入口，不作为 MCP runtime。
