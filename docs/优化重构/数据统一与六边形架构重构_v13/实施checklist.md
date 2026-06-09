# 数据统一与六边形架构重构 — 实施 Checklist

> 编码时逐项勾选。`[ ]` 表示未完成，`[x]` 表示已完成。
> 每个大项前的 `##` 标题对应方案文档中的章节编号。

---

## Phase A：数据层清理与验证

### A1. 残留碎片清理

- [ ] `db.json` 已删除，确认无代码引用
- [ ] `runtime/telegram-sync-pending.ndjson` 已评估（仍在使用则记录，已废弃则删除）
- [ ] 全局搜索确认 `runtime/` 中无其他残留文件

### A2. 写入路径审计

- [ ] 全局搜索 `fs.writeFile`、`fs.appendFile`（排除日志文件），确认无 JSON/SQLite 写入
- [ ] 全局搜索 `JSON.stringify` + `fs.writeFileSync` 组合，确认无数据写入 JSON
- [ ] 确认所有数据写入最终都通过 `src/db/training/write.mjs` 的 PostgreSQL Client 完成

### A3. 数据一致性验证

- [ ] `core.training_day` 与 `archive.training_day` 记录数对比（或合理差异说明）
- [ ] `core.sleep` 中无 orphaned 记录
- [ ] `ingest.telegram_batch` 中 `status = 'ready'` 记录均有对应的 `core.training_day`
- [ ] `core.measurement` 字段无异常值（负数、过大值）
- [ ] `core.activity` 中 `activity_type` 在预期范围内
- [ ] `core.sleep` 中 `bedtime` < `wake_time`

### A4. 数据模型文档化

- [ ] `docs/数据模型规范.md` 已更新（字段定义、约束说明、ER 图）

---

## Phase B：六边形架构重构

### B1. 核心域实体提取（PR #1）

- [ ] 创建 `src/core/entities/` 目录
- [ ] 创建 `TrainingRecord` 实体（从 `training-domain.mjs` 提取）
- [ ] 创建 `BodyMetric` 实体
- [ ] 创建 `SleepRecord` 实体
- [ ] 创建 `HealthDaily` 实体
- [ ] 创建 `ThoughtRecord` 实体
- [ ] 将 `mergeBatchIntoDay` 逻辑提取到 `TrainingRecord.mergeWith()`
- [ ] 将 `buildTrainingDay` 提取到 `TrainingRecord.fromRaw()`
- [ ] `src/db/training/write.mjs` 中替换为实体方法调用（保持逻辑不变）
- [ ] 编写实体单元测试（不依赖数据库）
- [ ] 验证：`npm run build` 和 Telegram 同步流程不受影响

### B2. 定义 Repository Port 接口（PR #2）

- [ ] 创建 `src/core/repositories/` 目录
- [ ] 定义 `TrainingRepositoryPort` 接口（`findByDate`、`save`、`findByDates`）
- [ ] 定义 `BodyMetricRepositoryPort` 接口
- [ ] 定义 `SleepRepositoryPort` 接口
- [ ] 定义 `HealthDailyRepositoryPort` 接口
- [ ] 定义 `ThoughtRepositoryPort` 接口
- [ ] 创建 `PostgresTrainingRepository` 类（空实现或部分实现）
- [ ] 验证：Port 接口编译/类型检查通过

### B3. `write.mjs` 拆分（PR #3）

- [ ] Step 1：提取领域逻辑到 `src/core/services/training-merge-service.mjs`
  - [ ] `mergeBatchIntoDay`
  - [ ] `buildTrainingDay`
  - [ ] `emptyNutrition`
  - [ ] `emptySleep`
- [ ] Step 2：提取 SQL 到 Repository
  - [ ] `upsertIngestBatch`
  - [ ] `upsertIngestMessages`
  - [ ] `upsertIngestRecognitions`
  - [ ] `writeCoreDays` / `readCoreDay`
  - [ ] `upsertArchiveParseSnapshot`
- [ ] Step 3：拆分 Telegram 批处理
  - [ ] 创建 `PostgresTelegramBatchRepository`
  - [ ] `persistNormalizedBatch` 中的 Telegram 逻辑迁移
- [ ] Step 4：拆分 Thought 处理
  - [ ] 创建 `PostgresThoughtRepository`
  - [ ] `persistThoughtMirror` 逻辑迁移
  - [ ] `persistThoughtToCore` 逻辑迁移
  - [ ] `markThoughtMirrorDeleted` 逻辑迁移
- [ ] 验证：每个新文件 < 300 行；总代码行数不变
- [ ] 验证：单元测试通过（Mock Repository）

### B4. `read.mjs` 拆分（PR #4）

- [ ] 提取 `readCoreDay` 到 `PostgresTrainingRepository.findByDate()`
- [ ] 提取 `readCoreDays` 到 `PostgresTrainingRepository.findByDates()`
- [ ] 提取快照构建到 `TrainingSnapshotService`
- [ ] 验证：`read.mjs` 中的 SQL 不再硬编码在调用方

### B5. AI Provider 适配器重构（PR #5）

- [ ] 定义 `AIProviderPort` 接口
- [ ] 将 `src/ai/provider.mjs` 逻辑抽取到 `src/adapters/ai/qwen.adapter.mjs`
- [ ] 将 `src/ai/openai-compatible-provider.mjs` 逻辑抽取到 `src/adapters/ai/openai-compatible.adapter.mjs`
- [ ] 实现 `ai-provider.factory.mjs`
- [ ] 编写适配器测试（Mock HTTP 请求）
- [ ] 更新 `src/ai/` 入口文件，转发到新的 Adapter

### B6. Telegram 适配器重构（PR #6）

- [ ] 定义 `TelegramBotPort` 接口
- [ ] 将 `src/telegram/` 中的 Polling 逻辑封装为 `polling.transport.mjs`
- [ ] 将 `src/telegram/` 中的 Webhook 逻辑封装为 `webhook.transport.mjs`
- [ ] 添加配置切换：`config.telegram.transport = 'polling' | 'webhook'`
- [ ] 验证：本地开发仍使用 Polling，生产使用 Webhook
- [ ] 编写 Webhook 签名验证测试

### B7. Runtime 模块适配器

- [ ] 评估 `runtime/telegram-sync-pending.ndjson` 是否仍在使用
- [ ] （若仍在使用）创建 `ingest.telegram_pending_batch` 表
- [ ] （若仍在使用）实现 `PostgresTelegramPendingRepository`
- [ ] （若不再使用）删除 `runtime/telegram-sync-pending.ndjson`

### B8. Hexo 数据生成适配器（PR #7）

- [ ] 定义 `HexoGeneratorPort` 接口
- [ ] 将 `tools/generate-training-data.mjs` 拆分到各 generator
  - [ ] `training-day.generator.mjs`
  - [ ] `body-metric.generator.mjs`
  - [ ] `dashboard.generator.mjs`
- [ ] 实现 `hexo-generator.adapter.mjs` 协调各 generator
- [ ] 编写 JSON 生成测试

### B9. 依赖注入容器（PR #8）

- [ ] 创建 `src/infra/di-container.mjs`
- [ ] 实现 `createContainer(config)` 函数
- [ ] 注册所有 Repository、Adapter、Use Case
- [ ] 验证：DI 容器启动时无循环依赖

### B10. 配置源统一（PR #8）

- [ ] 创建 `src/infra/config.mjs`，统一读取所有配置
- [ ] 添加配置校验（必填项缺失时启动失败）
- [ ] 更新 GitHub Actions workflow 使用统一配置
- [ ] 更新文档说明配置来源

### B11. 遗留代码清理（PR #8）

- [ ] `src/db/training/write.mjs` 拆分完成后删除（确认所有逻辑已迁移）
- [ ] `src/db/training/read.mjs` 拆分完成后删除
- [ ] `src/ai/provider.mjs` 迁移到 `src/adapters/ai/` 后删除
- [ ] `src/ai/openai-compatible-provider.mjs` 迁移到 `src/adapters/ai/` 后删除
- [ ] `src/domain/training/` 确认所有逻辑已迁移到 `src/core/` 后删除
- [ ] `runtime/*.ndjson` 确认迁移到 PostgreSQL 后删除
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

- [ ] 确认 `tools/generate-training-data.mjs` 从 PostgreSQL 查询数据
- [ ] 评估生成时间，确认 < 5 分钟

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

- [ ] 将 `src/jobs/telegram-sync-job.mjs` 迁移到 `src/app/use-cases/telegram-sync.use-case.mjs`
- [ ] 将 `src/jobs/training-analysis-job.mjs` 迁移到 `src/app/use-cases/training-analysis.use-case.mjs`
- [ ] 将 `src/jobs/generate-training-data-job.mjs` 迁移到 `src/app/use-cases/generate-training-data.use-case.mjs`
- [ ] 验证：Job 调度入口（GitHub Actions）保持不变

### C5. 文档更新

- [ ] 更新 `docs/部署维护/日常维护手册.md`
- [ ] 更新 `docs/部署维护/GitHub与Cloudflare配置.md`
- [ ] 新增 `docs/部署维护/数据迁移手册.md`
- [ ] 更新 `docs/系统架构/系统架构图.drawio`（六边形架构全景图）
- [ ] 更新 `docs/系统架构/模块依赖图.drawio`（四层依赖）
- [ ] 更新 `docs/系统架构/数据流图.drawio`（单一 PostgreSQL 数据源）
- [ ] 更新 `docs/系统架构/系统总览.md`
- [ ] 更新 `docs/系统架构/内部接口手册.md`（所有 Port 接口文档）
- [ ] 更新 `README.md`（安装、运行说明 + 六边形架构概述）
- [ ] 新增 `docs/系统架构/六边形架构指南.md`（架构原则、目录结构、开发规范）

---

## 里程碑检查点

| 检查点 | 目标 | 状态 |
| --- | --- | --- |
| Phase A 完成 | 数据层碎片清理完毕，PostgreSQL 数据一致性验证通过 | ⬜ 未开始 |
| B1 实体提取 | `src/core/entities/` 创建完成，单元测试通过 | ⬜ 未开始 |
| B2 Port 接口 | 所有 Repository Port 接口定义完成 | ⬜ 未开始 |
| B3 write.mjs 拆分 | `write.mjs` 拆分为多个 < 300 行的文件 | ⬜ 未开始 |
| B4 read.mjs 拆分 | `read.mjs` 拆分为 Repository + Service | ⬜ 未开始 |
| B5 AI 适配器 | `src/adapters/ai/` 创建完成 | ⬜ 未开始 |
| B6 Telegram 适配器 | Webhook 模式生产可用 | ⬜ 未开始 |
| B9 DI 容器 | `src/infra/di-container.mjs` 运行正常 | ⬜ 未开始 |
| B11 遗留清理 | 旧文件全部删除，无引用残留 | ⬜ 未开始 |
| B12 测试完成 | 所有测试通过，CI 配置完成 | ⬜ 未开始 |
| Phase C 完成 | 文档全部更新，构建优化完成 | ⬜ 未开始 |
| 全部完成 | v13 方案集全部落地 | ⬜ 未开始 |
