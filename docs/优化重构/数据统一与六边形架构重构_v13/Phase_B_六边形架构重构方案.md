# Phase B：六边形架构重构（建议 6–8 周）

> 目标：从当前模块化架构升级为六边形架构（Hexagonal / Ports & Adapters），让核心域与基础设施彻底解耦。所有外部依赖（Telegram、AI Provider、PostgreSQL、Hexo）通过 Adapter 接入，核心域零外部依赖。
>
> 前提：Phase A 数据层清理完成后开始。
>
> **重要**：本方案基于**当前代码实际**制定渐进式重构路径，而非从零创建新目录。每个步骤都是可独立验证的 PR。

## 当前架构问题诊断

当前代码结构：

```
src/
├── ai/                    # AI Provider（已有 Provider/Adapter 雏形）
├── db/training/           # 数据层（Repository 层雏形，但 write.mjs 1600+ 行耦合严重）
├── domain/training/       # 领域层（training-domain.mjs 有领域逻辑）
├── jobs/                  # Use Cases 雏形（Job 调度层）
├── telegram/              # Telegram 适配层雏形
└── shared/                # 共享工具
```

**核心痛点**：

1. **`src/db/training/write.mjs`（1600+ 行）耦合了**：事务管理、SQL 生成、领域逻辑（`mergeBatchIntoDay`、`buildTrainingDay`）、Telegram 批处理、Thought 处理
2. **`src/db/training/read.mjs` 耦合了**：SQL 硬编码、领域对象组装、快照构建
3. **无 Port 接口**：`src/db/training/` 直接暴露具体实现，上层模块（`src/jobs/`、`src/telegram/`）直接依赖具体 SQL
4. **`src/jobs/` 职责模糊**：Job 调度 vs Use Case 逻辑混合

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
| 3 | 拆分 `write.mjs` → Repository + Adapter + Service | 2 周 | PR #2 |
| 4 | 拆分 `read.mjs` → Repository + Snapshot Service | 1.5 周 | PR #2 |
| 5 | 重构 AI Provider 适配器 | 1 周 | PR #2 |
| 6 | 重构 Telegram 适配器 + Webhook | 1 周 | PR #5 |
| 7 | 重构 Hexo 数据生成适配器 | 3 天 | PR #4 |
| 8 | 统一配置 + DI 容器 + 遗留清理 | 1 周 | PR #7 |

## B1. 核心域实体提取（PR #1）

将现有 `src/domain/training/` 中的领域逻辑提取为纯领域实体：

**当前状态**：
- `src/domain/training/training-domain.mjs`：包含 `buildTrainingDay`、`emptyNutrition`、`emptySleep` 等领域逻辑
- `src/domain/training/training-parser.mjs`：包含 Markdown 解析的领域逻辑
- 但 `src/db/training/write.mjs` 中也混杂了 `mergeBatchIntoDay`、`buildTrainingDay` 等调用

**目标目录结构**：

```
src/core/
├── entities/
│   ├── training-record.mjs       # 从 training-domain.mjs 提取
│   ├── body-metric.mjs             # 测量数据实体
│   ├── sleep-record.mjs            # 睡眠记录实体
│   ├── health-daily.mjs            # 健康日报实体
│   └── thought-record.mjs         # 随想记录实体
└── services/
    └── training-snapshot-service.mjs  # 快照构建领域逻辑
```

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

## B3. `write.mjs` 拆分（PR #3）——核心难点

**当前状态**：`src/db/training/write.mjs` 1600+ 行，包含：
- 事务管理（`BEGIN`/`COMMIT`/`ROLLBACK`）
- SQL 生成（`upsertIngestBatch`、`upsertIngestMessages` 等）
- 领域逻辑（`mergeBatchIntoDay`、`buildTrainingDay`）
- Telegram 批处理（`persistNormalizedBatch`）
- Thought 处理（`persistThoughtMirror`、`persistThoughtToCore`）
- 归档逻辑（`upsertArchiveParseSnapshot`）

**拆分策略**：

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

## B4. `read.mjs` 拆分（PR #4）

**当前状态**：`src/db/training/read.mjs` 包含：
- SQL 查询（`readTrainingSnapshotFromDatabase` 等）
- 领域对象组装（`readCoreDay` 中从多表查询组装 TrainingDay）
- 快照构建（`buildTrainingSnapshotFromDaily`）

**拆分策略**：

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

## B5. AI Provider 适配器重构（PR #5）

**当前状态**：
- `src/ai/provider.mjs`：Qwen 主 Provider
- `src/ai/openai-compatible-provider.mjs`：OpenAI 兼容 Provider
- 已有一定分离，但缺少 Port 接口

**目标结构**：

```
src/adapters/ai/
├── ai-provider.port.mjs              # Port 接口
├── qwen.adapter.mjs                  # 从 provider.mjs 迁移
├── openai-compatible.adapter.mjs     # 从 openai-compatible-provider.mjs 迁移
└── ai-provider.factory.mjs           # 工厂
```

**实施步骤**：
1. 定义 `AIProviderPort` 接口（`generate` 方法）
2. 将 `src/ai/provider.mjs` 逻辑抽取到 `qwen.adapter.mjs`
3. 将 `src/ai/openai-compatible-provider.mjs` 逻辑抽取到 `openai-compatible.adapter.mjs`
4. 实现 `ai-provider.factory.mjs`（根据 `config.ai.provider` 选择）
5. 更新 `src/ai/` 入口文件，转发到新的 Adapter

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

## B7. Runtime 模块适配器（PR #7 的部分）

**当前状态**：
- `runtime/telegram-sync-pending.ndjson`：可能是 Telegram 同步队列
- 若仍在使用，需迁移到 PostgreSQL 表

**目标**：
- 若 `runtime/telegram-sync-pending.ndjson` 仍在作为队列使用：
  - 创建 `ingest.telegram_pending_batch` 表
  - 实现 `src/adapters/postgres/telegram-pending-repository.pg.mjs`
  - 替换 `fs.appendFile` 为 Repository 调用
- 若已不再使用：直接删除

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

## B9. 依赖注入容器（PR #8）

**目标**：创建 `src/infra/di-container.mjs`，统一管理依赖注入。

```javascript
// src/infra/di-container.mjs

export function createContainer(config) {
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

## B10. 遗留代码清理（PR #8）

| 目标 | 动作 |
| --- | --- |
| `src/db/training/write.mjs` | 拆分完成后删除（确认所有逻辑已迁移） |
| `src/db/training/read.mjs` | 拆分完成后删除 |
| `src/ai/provider.mjs` | 迁移到 `src/adapters/ai/` 后删除 |
| `src/ai/openai-compatible-provider.mjs` | 迁移到 `src/adapters/ai/` 后删除 |
| `src/domain/training/` | 确认所有逻辑已迁移到 `src/core/` 后删除 |
| `runtime/*.ndjson` | 确认迁移到 PostgreSQL 后删除 |

## B11. 测试与验证

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

## 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| `write.mjs` 拆分过程中引入 Bug | 每完成一个子步骤立即运行完整测试套件；保持现有函数签名不变（内部调用新模块） |
| 依赖注入增加复杂度 | 使用简单工厂模式，不引入 DI 框架；每个 PR 只引入一个新概念 |
| 性能下降（多一层抽象） | 性能测试对比，抽象层延迟 < 1ms |
| `mergeBatchIntoDay` 迁移后逻辑变化 | 编写详细的输入输出对比测试，确保新旧逻辑等价 |
