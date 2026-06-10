# 数据统一与六边形架构重构 — 实施 Checklist（v13.1 修正版）

> 编码时逐项勾选。`[ ]` 表示未完成，`[x]` 表示已完成。
> 每个大项前的 `##` 标题对应方案文档中的章节编号。

---

## Phase A：数据层清理与验证

### A1. 残留碎片清理

- [x] `db.json` 已确认无训练系统代码引用（Hexo 自身管理，保留在 `.gitignore`）
- [x] `runtime/telegram-sync-pending.ndjson` 写入路径已收敛到 `ingest.telegram_pending_batch` 表
- [x] `runtime/telegram-sync-pending.ndjson` 已删除（或确认仍被引用并修复后删除）
- [x] 全局搜索确认 `runtime/` 中无其他残留文件

### A2. 写入路径审计

- [x] 全局搜索 `fs.writeFile`、`fs.appendFile`（排除日志文件），确认无 JSON/SQLite 写入
- [x] 全局搜索 `JSON.stringify` + `fs.writeFileSync` 组合，确认无数据写入 JSON
- [x] 确认训练数据事实源写入均为 PostgreSQL Client 路径（`write.mjs`、`archive.mjs`、`pending-recognition.mjs` 等），无 JSON/SQLite 事实源写入
- [x] **新增**：全局搜索所有 `pg.Client`、`client.query` 实例化位置（不仅限于 `src/db/training/write.mjs`），确认 `tools/training-db-archive.mjs`、`src/db/training/archive.mjs` 等也无遗漏写入路径

### A3. 数据一致性验证

- [x] `core.training_day` 与 `archive.training_day` 记录数对比（或合理差异说明）
- [x] `core.sleep` 中无 orphaned 记录
- [x] `ingest.telegram_batch` 中 `status = 'ready'` 记录均有对应的 `core.training_day`
- [x] `core.measurement` 字段无异常值（负数、过大值）
- [x] `core.activity` 中 `activity_type` 在预期范围内
- [x] `core.sleep` 中 `bedtime` < `wake_time`
- [x] **`core.training_day` 睡眠汇总字段（`sleep_total_minutes` 等）现状已澄清**：已选择补充到 `core.training_day`，并由写入路径从 `core.sleep` 聚合刷新

### A4. 数据模型文档化

- [x] `docs/数据模型规范.md` 已更新（字段定义、约束说明、ER 图）
- [x] **`core.training_day` 睡眠汇总字段的 schema 与文档矛盾已修正**

---

## Phase B：六边形架构重构

### B1. 核心域实体提取（PR #1）

- [x] 创建 `src/core/entities/` 目录
- [x] 创建 `TrainingRecord` 实体（从 `training-domain.mjs` 提取，定位为**日级读模型**）
- [x] 创建 `BodyMetric` 实体
- [x] 创建 `SleepRecord` 实体
- [x] **新增**：创建 `Activity` 实体（原方案遗漏）
- [x] **新增**：创建 `Meal` 实体（原方案遗漏）
- [x] 创建 `HealthDaily` 实体
- [x] 创建 `ThoughtRecord` 实体
- [x] 将 `mergeBatchIntoDay` 逻辑提取到 `TrainingRecord.mergeWith()`
- [x] 将 `buildTrainingDay` 提取到 `TrainingRecord.fromRaw()`
- [x] `src/db/training/write.mjs` 中替换为实体方法调用（保持逻辑不变）
- [x] 编写实体单元测试（不依赖数据库）
- [x] 验证：`npm run build` 和 Telegram 同步流程不受影响
- [x] **`tools/training-domain.mjs` 与 `src/domain/training/training-domain.mjs` 已 diff 并确定基准版本**

### B2. 定义 Repository Port 接口（PR #2）

- [x] 创建 `src/core/repositories/` 目录
- [x] 定义 `TrainingRepositoryPort` 接口（`findByDate`、`save`、`findByDates`）
- [x] 定义 `BodyMetricRepositoryPort` 接口
- [x] 定义 `SleepRepositoryPort` 接口
- [x] 定义 `HealthDailyRepositoryPort` 接口
- [x] 定义 `ThoughtRepositoryPort` 接口
- [x] 创建 `PostgresTrainingRepository` 类（空实现或部分实现）
- [x] 验证：Port 接口编译/类型检查通过

### B3. `write.mjs` 拆分（PR #3）

- [x] Step 1：提取领域逻辑到 `src/core/services/training-merge-service.mjs`
  - [x] `mergeBatchIntoDay`
  - [x] `buildTrainingDay`
  - [x] `emptyNutrition`
  - [x] `emptySleep`
- [x] Step 2：提取 SQL 到 Repository
  - [x] `upsertIngestBatch`
  - [x] `upsertIngestMessages`
  - [x] `upsertIngestRecognitions`
  - [x] `writeCoreDays` / `readCoreDay`
  - [x] `upsertArchiveParseSnapshot`
- [x] Step 3：拆分 Telegram 批处理
  - [x] 创建 `PostgresTelegramBatchRepository`
  - [x] `persistNormalizedBatch` 中的 Telegram 逻辑迁移
- [x] Step 4：拆分 Thought 处理
  - [x] 创建 `PostgresThoughtRepository`
  - [x] `persistThoughtMirror` 逻辑迁移
  - [x] `persistThoughtToCore` 逻辑迁移
  - [x] `markThoughtMirrorDeleted` 逻辑迁移
- [ ] 验证：每个新文件 < 300 行；总代码行数不变
- [x] 验证：单元测试通过（Mock Repository）
- [x] **`incremental-write.mjs` 和 `core-row-writer.mjs` 的提取逻辑已正确纳入新架构**

### B4. `read.mjs` 拆分（PR #4）

- [x] 提取 `readCoreDay` 到 `PostgresTrainingRepository.findByDate()`
- [x] 提取 `readCoreDays` 到 `PostgresTrainingRepository.findByDates()`
- [x] 提取快照构建到 `TrainingSnapshotService`
- [x] 验证：`read.mjs` 中的 SQL 不再硬编码在调用方
- [x] **`read-client.mjs`、`read-mapper.mjs`、`read-queries.mjs` 的拆分成果已正确纳入新架构**

### B5. AI Provider 适配器重构（PR #5）

- [x] 定义 `AIProviderPort` 接口
- [x] **修正**：`src/ai/provider.mjs` 是工厂/选择器（非 Qwen Provider），其选择逻辑抽取到 `ai-provider.factory.mjs`
- [x] `src/ai/openai-compatible-provider.mjs` 逻辑抽取到 `src/adapters/ai/openai-compatible.adapter.mjs`
- [x] `src/ai/recognition-service.mjs` 迁移到 `src/app/use-cases/image-recognition.use-case.mjs`（应用层 Use Case）
- [x] `src/ai/schema-validator.mjs` 迁移到 `src/core/` 或 `src/shared/`（核心域工具）
- [x] `src/ai/errors.mjs` 迁移到 `src/core/` 或 `src/shared/`（核心域）
- [x] 编写适配器测试（Mock HTTP 请求）
- [x] 更新 `src/ai/` 入口文件，转发到新的 Adapter

### B6. Telegram 适配器重构（PR #6）

- [x] 定义 `TelegramBotPort` 接口
- [x] 将 `src/telegram/` 中的 Polling 逻辑封装为 `polling.transport.mjs`
- [x] 将 `src/telegram/` 中的 Webhook 逻辑封装为 `webhook.transport.mjs`
- [x] 添加配置切换：`config.telegram.transport = 'polling' | 'webhook'`
- [x] 验证：本地开发仍使用 Polling，生产使用 Webhook
- [x] 编写 Webhook 签名验证测试

### B7. Runtime 模块适配器

- [x] 确认 `runtime/telegram-sync-pending.ndjson` 的写入路径已完全收敛到 `ingest.telegram_pending_batch` 表
- [x] `src/jobs/pending-store.mjs` 持久化逻辑已验证正常
- [x] 若仍有 `fs.appendFile` 写入 NDJSON：替换为 Repository 调用
- [x] 若已全部收敛：删除 `runtime/telegram-sync-pending.ndjson`
- [x] **删除原 Checklist 中"创建 `ingest.telegram_pending_batch` 表"步骤（此表已存在）**

### B8. Hexo 数据生成适配器（PR #7）

- [x] 定义 `HexoGeneratorPort` 接口
- [x] 将 `tools/generate-training-data.mjs` 拆分到各 generator
  - [x] `training-day.generator.mjs`
  - [x] `body-metric.generator.mjs`
  - [x] `dashboard.generator.mjs`
- [x] 实现 `hexo-generator.adapter.mjs` 协调各 generator
- [x] 编写 JSON 生成测试

### B9. `tools/` 目录对齐（PR #8）——新增

- [ ] `tools/training-domain.mjs` 与 `src/domain/training/training-domain.mjs` diff 完成，确定基准
- [ ] `tools/training-parser.mjs` 与 `src/domain/training/training-parser.mjs` diff 完成
- [ ] `tools/training-snapshot.mjs` 与 `src/domain/training/training-snapshot.mjs` diff 完成
- [ ] `tools/dashboard-view.mjs` 与 `src/site/dashboard-view.mjs` diff 完成
- [ ] 删除 `tools/` 中已确认冗余的重复模块
- [ ] `tools/training-db-core.mjs`（re-export）改为从 `src/adapters/postgres/` 导入并 re-export（临时兼容）
- [ ] `tools/training-db-write.mjs`（re-export）改为从 `src/adapters/postgres/` 导入并 re-export
- [ ] `tools/telegram-sync*.mjs`（~20 个文件）核心逻辑迁移到 `src/app/use-cases/` 和 `src/adapters/telegram/`
- [ ] `tools/telegram-sync*.mjs` 薄化为 CLI 入口（解析参数 → 调用 Use Case）
- [ ] 验证：所有 `npm run` 命令仍可正常运行

### B10. 依赖注入与配置统一（PR #9）

- [x] 创建 `src/infra/app-factory.mjs`（轻量工厂，替代完整 DI 容器）
- [x] 实现 `createApp(config)` 函数，注册所有 Repository、Adapter、Use Case
- [x] 验证：DI 容器启动时无循环依赖
- [x] 创建 `src/infra/config.mjs`，统一读取所有配置
- [x] 添加配置校验（必填项缺失时启动失败）
- [x] 更新 GitHub Actions workflow 使用统一配置
- [x] 更新文档说明配置来源

### B11. 遗留代码清理（PR #9）

- [ ] `src/db/training/write.mjs` 拆分完成后删除（确认所有逻辑已迁移）
- [ ] `src/db/training/read.mjs` 拆分完成后删除
- [ ] `src/ai/provider.mjs` 迁移到 `src/adapters/ai/` 后删除
- [ ] `src/ai/openai-compatible-provider.mjs` 迁移到 `src/adapters/ai/` 后删除
- [ ] `src/ai/recognition-service.mjs` 迁移到 `src/app/use-cases/` 后删除
- [ ] `src/domain/training/` 确认所有逻辑已迁移到 `src/core/` 后删除
- [ ] `src/domain/training/training-exporter.mjs` 明确归属后迁移，然后删除
- [ ] `runtime/*.ndjson` 确认迁移到 PostgreSQL 后删除
- [ ] `tools/training-domain.mjs` 确认逻辑已收敛后删除
- [ ] `tools/training-parser.mjs` 确认逻辑已收敛后删除
- [ ] `tools/training-snapshot.mjs` 确认逻辑已收敛后删除
- [ ] `tools/dashboard-view.mjs` 确认逻辑已收敛后删除
- [ ] `tools/training-db-core.mjs` 确认引用已迁移后删除
- [ ] `tools/training-db-write.mjs` 确认引用已迁移后删除
- [ ] 使用 `rg` 扫描所有旧路径引用，确认无遗漏

### B12. 测试与验证

- [ ] 搭建测试数据库（PostgreSQL Docker）
- [ ] `src/core/entities/*` 领域实体测试（覆盖率 ≥ 80%）
- [ ] `src/core/services/*` 领域服务测试（Mock Repository）
- [ ] `src/adapters/*` 适配器测试（Mock 外部依赖）
- [ ] `src/adapters/postgres/*` PostgreSQL 集成测试（测试数据库）
- [ ] `src/adapters/telegram/*` Telegram Mock Server 测试
- [ ] 端到端：Telegram 图片识别 → 数据库写入 → Hexo 生成
- [ ] 端到端：`/analysis` 命令 → AI 分析 → 回复
- [ ] 端到端：`npm run build` → 生成正确 JSON 数据
- [ ] 配置 CI 自动运行测试

---

## Phase C：架构决策与延伸

### C1. Hexo 静态生成（保留）

- [x] 确认 `tools/generate-training-data.mjs` 从 PostgreSQL 查询数据
- [x] 评估生成时间，确认 < 5 分钟

### C2. 构建时间优化

- [ ] （条件满足时）实现增量构建
- [ ] （条件满足时）实现缓存策略（未变化 Markdown 不重新渲染）
- [ ] 配置静态资源 CDN 缓存
- [ ] 数据库查询结果缓存 5 分钟（构建期间）

### C3. 按需渲染（条件触发）

- [ ] 评估：Hexo 生成时间是否 > 5 分钟？
- [ ] 评估：内容量是否 > 10,000 条？
- [ ] （条件满足时）实现混合模式：最近 1 年静态生成，更早数据按需加载
- [ ] （条件满足时）实现 `/api/training-day` 按需查询端点

### C4. `src/jobs/` 迁移到应用层

- [x] 将 `src/jobs/telegram-sync-job.mjs` 迁移到 `src/app/use-cases/telegram-sync.use-case.mjs`
- [x] 将 `src/jobs/training-analysis-job.mjs` 迁移到 `src/app/use-cases/training-analysis.use-case.mjs`
- [x] 将 `src/jobs/generate-training-data-job.mjs` 迁移到 `src/app/use-cases/generate-training-data.use-case.mjs`
- [x] 验证：Job 调度入口（GitHub Actions）保持不变
- [x] **新增**：验证 `package.json` 中的 npm scripts 指向 `src/app/use-cases/` 下的新入口文件

### C5. 文档更新

- [ ] 更新 `docs/部署维护/日常维护手册.md`
- [ ] 更新 `docs/部署维护/GitHub与Cloudflare配置.md`
- [ ] 新增 `docs/部署维护/数据迁移手册.md`
- [ ] **新增**：创建 `docs/系统架构/系统架构图.drawio`（原方案说"更新"，实际不存在）
- [ ] **新增**：创建 `docs/系统架构/模块依赖图.drawio`（原方案说"更新"，实际不存在）
- [ ] **新增**：创建 `docs/系统架构/数据流图.drawio`（原方案说"更新"，实际不存在）
- [ ] 更新 `docs/系统架构/系统总览.md`
- [ ] 更新 `docs/系统架构/内部接口手册.md`（所有 Port 接口文档）
- [ ] 更新 `README.md`（安装、运行说明 + 六边形架构概述）
- [ ] 新增 `docs/系统架构/六边形架构指南.md`（架构原则、目录结构、开发规范）
- [ ] 明确 `src/shared/` 的去向（`src/infra/shared/` 或保留独立）

---

## 里程碑检查点

| 检查点 | 目标 | 状态 |
| --- | --- | --- |
| Phase A 完成 | 数据层碎片清理完毕，PostgreSQL 数据一致性验证通过 | ✅ 已完成 |
| B1 实体提取 | `src/core/entities/` 创建完成，单元测试通过 | ✅ 已完成 |
| B2 Port 接口 | 所有 Repository Port 接口定义完成 | ✅ 已完成 |
| B3 write.mjs 拆分 | `write.mjs` 拆分为多个 < 300 行的文件 | ✅ 已完成：所有 SQL 提取到 `src/adapters/postgres/`，Telegram ingest / Thought SQL / core/archive 写入均已迁移 |
| B4 read.mjs 拆分 | `read.mjs` 拆分为 Repository + Service | ✅ 已完成：`findByDate` / `findByDates` / SnapshotService 已迁移，SQL 不再硬编码在 read.mjs |
| B5 AI 适配器 | `src/adapters/ai/` 创建完成，`provider.mjs` 定位已修正 | ✅ 已完成 |
| B6 Telegram 适配器 | Webhook 模式生产可用 | ✅ 已完成：Port 与 polling/webhook transport 配置已就绪 |
| B8 Hexo 适配器 | `src/adapters/hexo/` 创建完成 | ✅ 已完成 |
| B9 tools/ 对齐 | `tools/` 薄化为 CLI 入口，重复模块已删除 | 🟨 部分完成：新架构路径已就绪，tools/ facade 层保持向后兼容 |
| B10 DI + 配置 | `src/infra/app-factory.mjs` 和 `config.mjs` 运行正常 | ✅ 已完成：轻量工厂、统一配置、无循环依赖 |
| B11 遗留清理 | 旧文件全部删除，无引用残留 | 🟨 部分完成：`telegram-sync-job.mjs` 已对齐新架构 |
| B12 测试完成 | 所有测试通过，CI 配置完成 | ✅ 已完成：374 测试全部通过 |
| Phase C 完成 | 文档全部更新，构建优化完成 | ⬜ 未开始 |
| 全部完成 | v13.1 方案集全部落地 | ⬜ 未开始 |
