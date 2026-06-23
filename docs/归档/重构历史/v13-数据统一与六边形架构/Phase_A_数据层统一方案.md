# Phase A：数据层清理与验证（建议 1 周）

> 目标：清理数据层残留碎片，验证 PostgreSQL 数据一致性，确认无 JSON/SQLite 写入路径残留，为 Phase B 六边形架构重构扫清障碍。
>
> 前提：当前代码中 PostgreSQL 已经是事实上的唯一数据源。本阶段不是"迁移"，而是"清理与确认"。

## A1. 残留碎片清理

### 1.1 `db.json` 与 `runtime/telegram-sync-pending.ndjson` 处理

| 文件/目录 | 当前状态 | 动作 |
| --- | --- | --- |
| `db.json` | Hexo 数据库缓存文件（构建提速用），由 Hexo 自身管理 | **保留在 `.gitignore` 中**，不属于本次重构范围 |
| `runtime/telegram-sync-pending.ndjson` | 残留 NDJSON 队列文件 | 确认写入路径已收敛到 `ingest.telegram_pending_batch` 表后删除 |

**实施步骤**：
1. `db.json`：确认无训练系统代码直接引用（Hexo 自身管理），保留在 `.gitignore` 中即可
2. `runtime/telegram-sync-pending.ndjson`：
   - 全局搜索 `fs.appendFile`、`fs.writeFile` 写入该 NDJSON 的路径
   - 确认 `src/jobs/pending-store.mjs` 已将写入逻辑收敛到 PostgreSQL `ingest.telegram_pending_batch` 表
   - 若已全部收敛：删除 NDJSON 文件及对应读写逻辑
   - 若仍有残留写入：先修复写入路径，再删除

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
| `core.training_day` | **注意**：当前 Schema 不包含睡眠汇总字段（`sleep_total_minutes`、`night_sleep_minutes`、`nap_minutes`、`sleep_start_time` 等）。这些字段仅存在于 `archive.training_day` 中。需先澄清：这些字段是否应通过 ALTER TABLE 补充到 `core.training_day`，还是通过 CTE/视图动态生成。|
| `core.measurement` | `weight_kg`、`body_fat_pct` 等字段无异常值（如负数、过大值） |
| `core.activity` | `activity_type` 在预期枚举范围内 |
| `core.sleep` | `bedtime` < `wake_time`，`total_sleep_minutes` 为正 |

## A4. 数据模型文档化

输出/更新 `docs/数据模型规范.md`，包含：

- 每个数据域的字段定义表和约束说明
- 表间关系图（ER 图）
- `core.*` 与 `archive.*` 的数据流向说明

## A5. Phase A 完成标准

- [ ] `db.json` 已确认无训练系统代码引用（Hexo 自身管理的缓存文件，保留在 `.gitignore`）
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
