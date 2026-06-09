# Phase A：数据层清理与验证（建议 1 周）

> 目标：清理数据层残留碎片，验证 PostgreSQL 数据一致性，确认无 JSON/SQLite 写入路径残留，为 Phase B 六边形架构重构扫清障碍。
>
> 前提：当前代码中 PostgreSQL 已经是事实上的唯一数据源。本阶段不是"迁移"，而是"清理与确认"。

## A1. 残留碎片清理

### 1.1 空文件清理

| 文件/目录 | 当前状态 | 动作 |
| --- | --- | --- |
| `db.json` | 0 字节空文件 | 删除，确认无代码引用 |
| `runtime/telegram-sync-pending.ndjson` | 残留 NDJSON | 评估是否仍需，若不需要则删除 |

**实施步骤**：
1. 全局搜索 `db.json` 引用（`rg "db\.json"`），确认无读取/写入逻辑
2. 全局搜索 `runtime/` 目录引用，确认 `telegram-sync-pending.ndjson` 是否仍在使用
3. 若 `telegram-sync-pending.ndjson` 仍在作为 Telegram 同步队列使用，在 Phase B 中将其迁移到 PostgreSQL `ingest.telegram_pending_batch`
4. 删除已确认无效的文件

### 1.2 `src/data/` 目录确认

文档早期版本假设存在 `src/data/` 目录存放 JSON 数据缓存。实际代码中：

- `src/data/` 目录**不存在**
- 数据读取已通过 `src/db/training/read.mjs` 直接查询 PostgreSQL

**结论**：无需创建兼容适配层，本项跳过。

## A2. 写入路径审计

确认所有写入操作已收敛到 PostgreSQL，无 JSON/SQLite 写入路径：

| 写入来源 | 目标 | 状态 |
| --- | --- | --- |
| Telegram 图片识别 | `ingest.telegram_batch` / `core.*` | ✅ PostgreSQL |
| `/analysis` 训练建议生成 | 读取 `core.*` / `archive.*` | ✅ PostgreSQL 只读 |
| 体脂秤数据 | `core.measurement` | ✅ PostgreSQL |
| 睡眠数据 | `core.sleep` | ✅ PostgreSQL |
| Markdown 导入 | `archive.training_parse_snapshot` | ✅ PostgreSQL |
| Hexo 站点构建 | 从 PostgreSQL 读取生成 JSON | ✅ PostgreSQL 只读 |

**审计方法**：
1. 全局搜索 `fs.writeFile`、`fs.appendFile`（排除日志文件）
2. 全局搜索 `JSON.stringify` + `fs.writeFileSync` 组合
3. 确认所有数据写入最终都通过 `src/db/training/write.mjs` 的 PostgreSQL Client 完成

## A3. 数据一致性验证

### 3.1 表级校验

编写一次性校验脚本，验证以下数据一致性：

- `core.training_day` 的记录数 == `archive.training_day` 中非重复的记录数（或合理差异）
- `core.sleep` 中无 orphaned 记录（`archived_date` 在 `core.training_day` 中存在）
- `ingest.telegram_batch` 中 `status = 'ready'` 的记录，`archived_date` 在 `core.training_day` 中均有对应

### 3.2 字段完整性检查

| 表 | 检查项 |
| --- | --- |
| `core.training_day` | 所有记录 `archived_date` 非空，格式正确 |
| `core.measurement` | `weight_kg`、`body_fat_pct` 等字段无异常值（如负数、过大值） |
| `core.activity` | `activity_type` 在预期枚举范围内 |
| `core.sleep` | `bedtime` < `wake_time`，`total_sleep_minutes` 为正 |

## A4. 数据模型文档化

输出/更新 `docs/数据模型规范.md`，包含：

- 每个数据域的字段定义表和约束说明
- 表间关系图（ER 图）
- `core.*` 与 `archive.*` 的数据流向说明

## A5. Phase A 完成标准

- [ ] `db.json` 已删除，无代码引用
- [ ] `runtime/` 中残留文件已评估并处理
- [ ] 全局审计确认无 JSON/SQLite 写入路径
- [ ] 数据一致性校验脚本通过
- [ ] `docs/数据模型规范.md` 已更新

## 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 误删仍在使用的文件 | 删除前全局搜索引用，确认无引用后再删除 |
| `runtime/telegram-sync-pending.ndjson` 仍有写入 | 先确认写入方，再在 Phase B 中迁移到 PostgreSQL |
| 数据一致性校验发现历史数据问题 | 记录问题清单，评估是否需要在 Phase B 前修复 |
