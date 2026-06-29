# Phase B：六边形架构重构（建议 10–14 周）

> 目标：从当前模块化架构升级为六边形架构（Hexagonal / Ports & Adapters），让核心域与基础设施彻底解耦。所有外部依赖（Telegram、AI Provider、PostgreSQL、Hexo）通过 Adapter 接入，核心域零外部依赖。
>
> 前提：Phase A 数据层清理完成后开始。
>
> **重要**：本方案基于**当前代码实际**制定渐进式重构路径，而非从零创建新目录。每个步骤都是可独立验证的 PR。
>
> **版本修正**：v13.1 — 根据代码审查意见修正了以下事实偏差：`tools/` 目录遗漏、`write.mjs`/`read.mjs` 当前状态、`provider.mjs` 定位、`ingest.telegram_pending_batch` 表状态、DI 容器必要性评估、配置源统一缺失章节、整体时间估算。

## 当前架构问题诊断

当前代码结构：

```
src/
├── ai/                    # AI Provider（已有 Provider/Adapter 雏形）
├── db/training/           # 数据层（Repository 层雏形，但 write.mjs、read.mjs 耦合严重）
├── domain/training/       # 领域层（training-domain.mjs 有领域逻辑）
├── jobs/                  # Use Cases 雏形（Job 调度层）
├── telegram/              # Telegram 适配层雏形
└── shared/                # 共享工具

tools/                     # CLI 入口与业务逻辑（双轨问题的根源）
├── training-domain.mjs
├── training-parser.mjs
├── training-snapshot.mjs
├── dashboard-view.mjs
├── training-db-core.mjs   # 聚合 facade（re-export）
├── training-db-write.mjs  # re-export 层
└── telegram-sync*.mjs     # ~20 个 Telegram 同步文件
```

**核心痛点**：

1. **`src/db/training/write.mjs`（已部分拆分）**：事务管理、SQL 生成、领域逻辑（`mergeBatchIntoDay`、`buildTrainingDay`）、Telegram 批处理、Thought 处理仍高度耦合。虽已拆出 `incremental-write.mjs` 和 `core-row-writer.mjs`，但主文件仍保留事务协调、批次管理和归档逻辑。
2. **`src/db/training/read.mjs`（已部分拆分）**：SQL 查询已拆分到 `read-client.mjs`、`read-mapper.mjs`、`read-queries.mjs`，但聚合入口仍耦合快照构建逻辑。
3. **无 Port 接口**：`src/db/training/` 直接暴露具体实现，上层模块（`src/jobs/`、`src/telegram/`）直接依赖具体 SQL。
4. **`src/jobs/` 职责模糊**：Job 调度 vs Use Case 逻辑混合。
5. **`tools/` 与 `src/` 双轨问题（最严重结构性遗漏）**：`tools/` 目录包含大量与 `src/` 平行的重复模块和 facade 层。若仅重构 `src/` 而不同步清理 `tools/`，会导致系统出现两套模块体系，增加维护成本。

## 目标架构全景

```
                    ┌─────────────────┐
                    │   Telegram Bot   │
                    └────────┬────────┘
                             │ Adapter
                             ▼
┌─────────────────────────────────────────────────────────┐
│                      应用层（Use Cases）                   │
│                                                         │
│  ImageRecognitionUseCase   HealthImportUseCase         │
│  TrainingAnalysisUseCase     TelegramSyncJob            │
│                                                         │
└────────────────────────┬────────────────────────────────┘
                         │ 调用
                         ▼
┌─────────────────────────────────────────────────────────┐
│                      核心域（Core Domain）                │
│                                                         │
│  TrainingRecord  BodyMetric  SleepRecord  HealthDaily   │
│                                                         │
│  Repository（Port 接口） Domain Services  Domain Events │
│                                                         │
│              ※ 零外部依赖，纯 JavaScript                 │
│              ※ 不 import pg / node:fs / openai         │
│              ※ 所有 I/O 通过 Port 接口                  │
│                                                         │
└────────────────────────┬────────────────────────────────┘
                         │ 实现
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    适配器层（Adapters）                    │
│                                                         │
│  PostgresTrainingRepository  TelegramBotAdapter          │
│  QwenAIProvider              OpenAICompatibleProvider   │
│  HexoGeneratorAdapter        CsvParserAdapter            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 渐进式重构策略

**原则**：每个 PR 只重构一个边界，确保系统始终可运行。

| PR # | 目标 | 预计时间 | 依赖 |
| --- | --- | --- | --- |
| 1 | 提取核心域实体（`src/core/entities/`） | 1 周 | Phase A |
| 2 | 定义 Repository Port 接口 | 3 天 | PR #1 |
| 3 | 拆分 `write.mjs` → Repository + Adapter + Service | 1.5 周 | PR #2 |
| 4 | 拆分 `read.mjs` → Repository + Snapshot Service | 1 周 | PR #2 |
| 5 | 重构 AI Provider 适配器 | 1 周 | PR #2 |
| 6 | 重构 Telegram 适配器 + Webhook | 1 周 | PR #5 |
| 7 | Hexo 数据生成适配器 + `tools/` 重复模块去重 | 3 天 | PR #4 |
| 8 | `tools/` 目录对齐（CLI 入口薄化 + re-export 清理） | 2 周 | PR #7 |
| 9 | 依赖注入 + 配置统一 + 遗留清理 | 1 周 | PR #8 |

> **说明**：总时间从 v13 原方案的 6–8 周调整为 **10–14 周**。主要增量来自：PR #8 `tools/` 对齐（含 ~20 个 Telegram sync 文件重组）、测试数据库搭建、CI/CD 集成验证、生产环境数据迁移验证。

---

## B1. 核心域实体提取（PR #1）

将现有 `src/domain/training/` 中的领域逻辑提取为纯领域实体：

**当前状态**：
- `src/domain/training/training-domain.mjs`：包含 `buildTrainingDay`、`emptyNutrition`、`emptySleep` 等领域逻辑
- `src/domain/training/training-parser.mjs`：包含 Markdown 解析的领域逻辑
- 但 `src/db/training/write.mjs` 中也混杂了 `mergeBatchIntoDay`、`buildTrainingDay` 等调用
- **`tools/training-domain.mjs`、`tools/training-parser.mjs` 与 `src/domain/training/` 中的对应文件为两个独立文件，内容可能不一致——这是双轨问题的核心表现之一**

**目标目录结构**：

```
src/core/
├── entities/
│   ├── training-record.mjs       # 从 training-domain.mjs 提取，定位为"日级读模型"
│   ├── body-metric.mjs             # 测量数据实体
│   ├── sleep-record.mjs            # 睡眠记录实体
│   ├── activity.mjs                # 运动明细实体（新增，原方案遗漏）
│   ├── meal.mjs                    # 餐次/营养实体（新增，原方案遗漏）
│   ├── health-daily.mjs            # 健康日报实体
│   └── thought-record.mjs         # 随想记录实体
└── services/
    └── training-snapshot-service.mjs  # 快照构建领域逻辑
```

**关键设计决策**：

1. **`TrainingRecord` 是"日级读模型"（Read Model），而非写入实体容器**。当前系统以子表独立管理各数据域（`core.measurement`、`core.activity`、`core.meal`、`core.sleep`），Telegram 图片批次以**增量 upsert** 方式写入各子表，不会整日替换。因此各子表实体需要独立建模。

2. **`tools/training-domain.mjs` 与 `src/domain/training/training-domain.mjs` 的去重**：
   - 实施前，先 diff 两个文件的内容差异
   - 以 `src/domain/training/training-domain.mjs` 为基准（因为它被更多模块引用）
   - 提取到 `src/core/entities/` 后，`tools/training-domain.mjs` 改为 re-export 新实体（临时兼容），最终在 PR #8 中删除

**关键拆分**：

```javascript
// src/core/entities/training-record.mjs
// 零外部依赖，纯 JavaScript

export class TrainingRecord {
  constructor({ date, activities, measurements, nutrition, sleep, workoutSummary }) {
    this.date = date;
    this.activities = activities ?? [];
    this.measurements = measurements ?? [];
    this.nutrition = nutrition ?? { meals: [], totalCalories: null };
    this.sleep = sleep ?? { records: [] };
    this.workoutSummary = workoutSummary ?? {};
  }

  static fromRaw(raw) {
    // 领域校验
    if (!raw.date) throw new Error('TrainingRecord.date is required');
    return new TrainingRecord(raw);
  }

  mergeWith(batch) {
    // 将 mergeBatchIntoDay 逻辑迁移到实体方法
    // ...
  }

  addMeasurement(measurement) {
    // ...
  }
}
```

**实施步骤**：
1. 创建 `src/core/entities/` 目录
2. 将 `training-domain.mjs` 中的 `buildTrainingDay`、`emptyNutrition`、`emptySleep` 等函数提取为实体类方法
3. 在 `src/db/training/write.mjs` 中替换为实体方法调用（保持现有逻辑不变，只是调用方式改变）
4. 编写实体单元测试（不依赖数据库）
5. 验证：现有 `npm run build` 和 Telegram 同步流程不受影响
6. **`tools/training-domain.mjs` 去重**：临时改为 re-export 新实体，在 PR #8 中删除

---

## B2. 定义 Repository Port 接口（PR #2）

**当前问题**：`src/db/training/write.mjs` 和 `read.mjs` 直接暴露 PostgreSQL 客户端操作，上层模块直接依赖具体实现。

**目标目录结构**：

```
src/core/
└── repositories/
    ├── training-repository.port.mjs       # 训练记录仓库接口
    ├── body-metric-repository.port.mjs    # 体脂秤仓库接口
    ├── sleep-repository.port.mjs          # 睡眠记录仓库接口
    └── health-daily-repository.port.mjs   # 健康日报仓库接口
```

**Port 接口示例**：

```javascript
// src/core/repositories/training-repository.port.mjs

/**
 * 训练记录仓库 Port 接口
 * @interface TrainingRepositoryPort
 */
export class TrainingRepositoryPort {
  /**
   * @param {string} date - YYYY-MM-DD
   * @returns {Promise<TrainingRecord|null>}
   */
  async findByDate(date) {
    throw new Error('Not implemented: findByDate');
  }

  /**
   * @param {TrainingRecord} record
   * @returns {Promise<void>}
   */
  async save(record) {
    throw new Error('Not implemented: save');
  }

  /**
   * @param {string[]} dates
   * @returns {Promise<TrainingRecord[]>}
   */
  async findByDates(dates) {
    throw new Error('Not implemented: findByDates');
  }
}
```

**实施步骤**：
1. 在 `src/core/repositories/` 中定义所有 Port 接口（JSDoc `@interface`）
2. 创建 `src/adapters/postgres/training-repository.pg.mjs`，实现 `TrainingRepositoryPort`
3. 保持现有 `src/db/training/write.mjs` 功能不变，但新增 `PostgresTrainingRepository` 类封装其逻辑
4. 验证：上层调用方可通过 Port 接口调用，也可继续使用现有函数（兼容期）

---

## B3. `write.mjs` 拆分（PR #3）——核心难点

**当前状态（v13.1 修正）**：`write.mjs` 已经从单体拆分为多个协作文件：
- `incremental-write.mjs` — Telegram 图片增量写入
- `core-row-writer.mjs` — 各子表行级 upsert（`insertCoreActivities`、`insertCoreMeasurements`、`insertCoreMeals`、`insertCoreSleep`）
- `write.mjs` 本身仍保留事务管理、批次协调、Thought 处理、Markdown 导入逻辑

**剩余拆分策略**：

```
src/db/training/write.mjs 拆分为：

src/core/repositories/training-repository.port.mjs      # Port 接口（已定义）
src/adapters/postgres/training-repository.pg.mjs        # PostgreSQL 实现
src/core/services/training-merge-service.mjs            # 领域逻辑（mergeBatchIntoDay）
src/adapters/postgres/telegram-batch-repository.pg.mjs  # Telegram 批处理 SQL
src/adapters/postgres/thought-repository.pg.mjs         # Thought SQL
src/adapters/postgres/archive-repository.pg.mjs         # 归档 SQL
```

**渐进拆分步骤**：

1. **Step 1：提取领域逻辑到 Service**
   - 将 `mergeBatchIntoDay` 提取到 `src/core/services/training-merge-service.mjs`
   - 将 `buildTrainingDay` 提取到 `src/core/entities/` 的工厂方法
   - 验证：`write.mjs` 逻辑不变，只是调用外部 Service

2. **Step 2：提取 SQL 到 Repository 类**
   - 创建 `PostgresTrainingRepository extends TrainingRepositoryPort`
   - 将 `upsertIngestBatch`、`upsertIngestMessages`、`upsertIngestRecognitions` 等提取为私有方法
   - 将 `writeCoreDays`、`readCoreDay` 等提取为公有方法

3. **Step 3：拆分 Telegram 批处理和 Thought 处理**
   - 创建 `PostgresTelegramBatchRepository`
   - 创建 `PostgresThoughtRepository`
   - 将 `persistNormalizedBatch` 中的 Telegram 和 Thought 逻辑迁移到对应 Repository

**验证标准**：
- `write.mjs` 拆分为多个文件后，总代码行数不变（只是物理拆分）
- 每个新文件 < 300 行
- 单元测试通过（Mock Repository）

---

## B4. `read.mjs` 拆分（PR #4）

**当前状态（v13.1 修正）**：`read.mjs` 已经拆分为：
- `read.mjs` — 聚合入口
- `read-client.mjs` — Client 创建
- `read-mapper.mjs` — 行映射
- `read-queries.mjs` — SQL 查询

**剩余拆分策略**：

```
src/db/training/read.mjs 拆分为：

src/core/repositories/training-repository.port.mjs       # Port 接口（已定义）
src/adapters/postgres/training-repository.pg.mjs        # PostgreSQL 实现（含读取）
src/core/services/training-snapshot-service.mjs       # 快照构建领域逻辑
```

**关键改动**：

```javascript
// src/adapters/postgres/training-repository.pg.mjs
export class PostgresTrainingRepository extends TrainingRepositoryPort {
  constructor(pgPool) {
    super();
    this.pgPool = pgPool;
  }

  async findByDate(date) {
    // 从 read.mjs 的 readCoreDay 迁移而来
    const dayResult = await this.pgPool.query(/* ... */);
    const measurementResult = await this.pgPool.query(/* ... */);
    // ... 组装 TrainingRecord
    return TrainingRecord.fromRaw({/* ... */});
  }

  async findByDates(dates) {
    // 批量查询优化
  }
}
```

---

## B5. AI Provider 适配器重构（PR #5）

**当前状态（v13.1 修正）**：
- `src/ai/provider.mjs`：**工厂/适配器选择器**，默认 `openai-compatible`。它不是 Qwen 专用 Provider，而是根据配置选择 Provider 的工厂。
- `src/ai/openai-compatible-provider.mjs`：OpenAI 兼容 Provider 实现
- `src/ai/recognition-service.mjs`：Telegram 图片识别的核心编排层，同时依赖 AI Provider、数据库识别缓存、schema 校验器。它属于**应用层 Use Case**。
- `src/ai/schema-validator.mjs`：AI 输出 schema 校验，属于**核心域工具**（无外部依赖）
- `src/ai/errors.mjs`：AI 相关错误定义，属于**核心域**

**目标结构**：

```
src/adapters/ai/
├── ai-provider.port.mjs              # Port 接口
├── qwen.adapter.mjs                  # Qwen 专用实现（如有）
├── openai-compatible.adapter.mjs     # 从 openai-compatible-provider.mjs 迁移
└── ai-provider.factory.mjs           # 从 provider.mjs 迁移（工厂选择逻辑）

src/app/use-cases/
└── image-recognition.use-case.mjs    # 从 recognition-service.mjs 迁移（应用层编排）
```

**实施步骤**：
1. 定义 `AIProviderPort` 接口（`generate` 方法）
2. 将 `src/ai/openai-compatible-provider.mjs` 逻辑抽取到 `openai-compatible.adapter.mjs`
3. 将 `src/ai/provider.mjs` 的工厂选择逻辑抽取到 `ai-provider.factory.mjs`
4. 将 `src/ai/recognition-service.mjs` 迁移到 `src/app/use-cases/image-recognition.use-case.mjs`
5. `src/ai/schema-validator.mjs` 和 `src/ai/errors.mjs` 迁移到 `src/core/` 或 `src/shared/`
6. 更新 `src/ai/` 入口文件，转发到新的 Adapter

---

## B6. Telegram 适配器重构（PR #6）

**当前状态**：
- `src/telegram/` 已具备命令处理层
- `package.json` 中已有 `telegram:webhook` 脚本
- 已有 `src/telegram/sync.mjs`、`sync-batch.mjs` 等文件

**目标结构**：

```
src/adapters/telegram/
├── telegram-bot.port.mjs             # Port 接口
├── telegram-bot.adapter.mjs        # 主适配器
├── command-router.mjs              # 命令路由（从 command-registry.mjs 迁移）
├── polling.transport.mjs           # Polling 模式
├── webhook.transport.mjs           # Webhook 模式（已部分实现）
└── media-handler.mjs               # 图片处理
```

**实施步骤**：
1. 定义 `TelegramBotPort` 接口
2. 将 `src/telegram/` 中的 Polling 逻辑封装为 `polling.transport.mjs`
3. 将 `src/telegram/` 中的 Webhook 逻辑封装为 `webhook.transport.mjs`
4. 添加配置切换：`config.telegram.transport = 'polling' | 'webhook'`
5. 编写 Cloudflare Worker Webhook 端点（若未实现）

---

## B7. Runtime 模块适配器（PR #7 的部分）

**当前状态（v13.1 修正）**：`ingest.telegram_pending_batch` 表**已经存在**于 `sql/training_records/ingest.sql` 中，包含完整字段定义（`pending_id`、`batch_id`、`kind`、`status`、`batch_payload_json`、`failure_category`、`attempt_count`、`next_retry_at` 等）。同时 `src/jobs/pending-store.mjs` 也已经存在对应的持久化逻辑。

**目标**：
- 确认 `runtime/telegram-sync-pending.ndjson` 的写入路径已完全收敛到 `ingest.telegram_pending_batch` 表
- 若仍有 `fs.appendFile` 写入 NDJSON 的逻辑，替换为 Repository 调用
- 若已全部收敛：删除 `runtime/telegram-sync-pending.ndjson` 及对应读写逻辑

---

## B8. Hexo 数据生成适配器（PR #7 的部分）

**当前状态**：
- `tools/generate-training-data.mjs`：从 PostgreSQL 读取数据生成 Hexo JSON
- `src/site/dashboard-view.mjs`：视图层

**目标结构**：

```
src/adapters/hexo/
├── hexo-generator.port.mjs        # Port 接口
├── hexo-generator.adapter.mjs   # 主适配器
└── generators/
    ├── training-day.generator.mjs
    ├── body-metric.generator.mjs
    └── dashboard.generator.mjs
```

**实施步骤**：
1. 定义 `HexoGeneratorPort` 接口
2. 将 `tools/generate-training-data.mjs` 拆分到各 generator
3. 实现 `hexo-generator.adapter.mjs` 协调各 generator

---

## B9. `tools/` 目录对齐（PR #8）——新增，v13 最大遗漏

**问题诊断**：当前系统有两条平行的模块路径：

| 模块 | `tools/` 版本 | `src/` 版本 | 关系 |
| --- | --- | --- | --- |
| `training-domain.mjs` | `tools/training-domain.mjs` | `src/domain/training/training-domain.mjs` | 两个独立文件 |
| `training-parser.mjs` | `tools/training-parser.mjs` | `src/domain/training/training-parser.mjs` | 两个独立文件 |
| `training-snapshot.mjs` | `tools/training-snapshot.mjs` | `src/domain/training/training-snapshot.mjs` | 两个独立文件 |
| `dashboard-view.mjs` | `tools/dashboard-view.mjs` | `src/site/dashboard-view.mjs` | 两个独立文件 |
| DB facade | `tools/training-db-core.mjs`（聚合 re-export） | `src/db/training/*.mjs`（实现） | facade → 实现 |
| DB write | `tools/training-db-write.mjs`（re-export） | `src/db/training/write.mjs`（实现） | re-export → 实现 |
| Telegram sync | `tools/telegram-sync.mjs`、`tools/telegram-sync-lib.mjs` 等（~20 个文件） | `src/telegram/sync.mjs`、`src/telegram/sync-batch.mjs` | 大量逻辑在 tools/ |
| AI provider | — | `src/ai/*.mjs` | 仅在 src/ |

**目标**：`tools/` 目录薄化为 CLI 入口（thin wrapper），核心逻辑全部迁移到 `src/` 各层。

**实施步骤**：
1. **重复模块去重**：
   - diff `tools/training-domain.mjs` 与 `src/domain/training/training-domain.mjs`，确认差异后删除 `tools/` 版本
   - 同理处理 `training-parser.mjs`、`training-snapshot.mjs`、`dashboard-view.mjs`
2. **re-export 文件迁移**：
   - `tools/training-db-core.mjs`：改为从 `src/adapters/postgres/` 导入并 re-export（临时兼容），最终在 PR #9 中删除
   - `tools/training-db-write.mjs`：同上
3. **Telegram sync 链路重组**：
   - `tools/telegram-sync*.mjs`（~20 个文件）的核心逻辑迁移到 `src/app/use-cases/` 和 `src/adapters/telegram/`
   - `tools/telegram-sync*.mjs` 薄化为 CLI 入口（解析参数 → 调用 Use Case）
4. **验证**：所有 `npm run` 命令仍可正常运行

---

## B10. 依赖注入与统一配置（PR #9）

### B10.1 依赖注入（DI）

**评估（v13.1 修正）**：当前系统是**基于 npm scripts + GitHub Actions 的 Job 型系统**，并非长期运行的服务进程。每个 Job 独立启动 Node.js 进程、创建 pg Client、执行任务后退出。因此：
- 不存在跨请求的依赖复用需求
- DI 容器在每次 Job 启动时创建一次后即被丢弃
- 简单的工厂函数（`createApp(config)`）已能满足当前需求

**目标**：采用轻量方案，一个 `createApp(config)` 工厂函数足矣，不引入完整 DI 容器模式。

```javascript
// src/infra/app-factory.mjs（替代原 di-container.mjs）

export function createApp(config) {
  const pgPool = createPgPool(config.database);

  const trainingRepository = new PostgresTrainingRepository(pgPool);
  const telegramBot = new TelegramBotAdapter(config.telegram);
  const aiProvider = AIProviderFactory.create(config.ai);
  const hexoGenerator = new HexoGeneratorAdapter(config.hexo);

  return {
    trainingRepository,
    telegramBot,
    aiProvider,
    hexoGenerator,
    // Use Cases
    imageRecognitionUseCase: new ImageRecognitionUseCase({
      trainingRepository,
      aiProvider,
    }),
    trainingAnalysisUseCase: new TrainingAnalysisUseCase({
      trainingRepository,
      aiProvider,
    }),
  };
}
```

### B10.2 配置源统一

**当前问题**：配置分散在多个文件中：
- `src/db/training/config.mjs` — 数据库配置
- `tools/training-db-config.mjs` — 数据库配置 re-export
- 各模块通过 `options.env` 直接读取 `process.env`

**目标**：
- 创建 `src/infra/config.mjs`，统一读取所有配置
- 添加配置校验（必填项缺失时启动失败）
- 更新 GitHub Actions workflow 使用统一配置
- 更新文档说明配置来源

---

## B11. 遗留代码清理（PR #9）

| 目标 | 动作 |
| --- | --- |
| `src/db/training/write.mjs` | 拆分完成后删除（确认所有逻辑已迁移） |
| `src/db/training/read.mjs` | 拆分完成后删除 |
| `src/ai/provider.mjs` | 迁移到 `src/adapters/ai/` 后删除 |
| `src/ai/openai-compatible-provider.mjs` | 迁移到 `src/adapters/ai/` 后删除 |
| `src/ai/recognition-service.mjs` | 迁移到 `src/app/use-cases/` 后删除 |
| `src/domain/training/` | 确认所有逻辑已迁移到 `src/core/` 后删除 |
| `src/domain/training/training-exporter.mjs` | 明确归属（领域服务还是适配器）后迁移，然后删除 |
| `runtime/*.ndjson` | 确认迁移到 PostgreSQL 后删除 |
| `tools/training-domain.mjs` | 确认与 `src/domain/training/training-domain.mjs` 逻辑已收敛后删除 |
| `tools/training-parser.mjs` | 确认与 `src/domain/training/training-parser.mjs` 逻辑已收敛后删除 |
| `tools/training-snapshot.mjs` | 确认与 `src/domain/training/training-snapshot.mjs` 逻辑已收敛后删除 |
| `tools/dashboard-view.mjs` | 确认与 `src/site/dashboard-view.mjs` 逻辑已收敛后删除 |
| `tools/training-db-core.mjs` | 确认所有引用已迁移到 `src/adapters/postgres/` 后删除 |
| `tools/training-db-write.mjs` | 确认所有引用已迁移到 `src/adapters/postgres/` 后删除 |

---

## B12. 测试与验证

**测试金字塔**：

- **单元测试（覆盖率 ≥ 80%）**
  - `src/core/entities/*`：领域实体测试（不依赖数据库）
  - `src/core/services/*`：领域服务测试（Mock Repository）
  - `src/adapters/*`：适配器测试（Mock 外部依赖）

- **集成测试**
  - `src/adapters/postgres/*`：PostgreSQL 集成测试（使用测试数据库 Docker）
  - `src/adapters/telegram/*`：Telegram Mock Server 测试

- **端到端测试**
  - Telegram 图片识别 → 数据库写入 → Hexo 生成
  - `/analysis` 命令 → AI 分析 → 回复
  - `npm run build` → 生成正确 JSON 数据

**实施步骤**：
1. 搭建测试数据库（PostgreSQL Docker）
2. 编写所有实体和领域服务单元测试
3. 编写所有适配器集成测试
4. 编写 3 个核心端到端测试
5. 配置 CI 自动运行测试

---

## 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| `write.mjs` 拆分过程中引入 Bug | 每完成一个子步骤立即运行完整测试套件；保持现有函数签名不变（内部调用新模块） |
| 依赖注入增加复杂度 | 使用简单工厂模式，不引入 DI 框架；每个 PR 只引入一个新概念 |
| 性能下降（多一层抽象） | 性能测试对比，抽象层延迟 < 1ms |
| `mergeBatchIntoDay` 迁移后逻辑变化 | 编写详细的输入输出对比测试，确保新旧逻辑等价 |
| `tools/` 与 `src/` 双轨问题导致系统分裂 | PR #8 专门处理 `tools/` 对齐；删除前 diff 确认内容一致性 |
| Telegram sync 链路重构导致数据丢失 | ~20 个 `tools/telegram-sync*.mjs` 文件逐个迁移，每步验证；保留回滚方案 |
| `core.training_day` 睡眠汇总字段与 schema 不一致 | Phase A 中已澄清 schema 现状；Phase B 中根据决策补充或修正文档 |
