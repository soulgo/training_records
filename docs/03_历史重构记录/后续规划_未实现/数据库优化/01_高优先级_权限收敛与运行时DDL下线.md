# 高优先级：权限收敛与运行时 DDL 下线

> 优先级：高
> 目标：降低 PostgreSQL 被误用或被攻破后的破坏半径。业务运行账号只做业务读写，DDL 和 schema 迁移只能由显式迁移账号执行。

## 当前证据

| 事实 | 证据 |
| --- | --- |
| 运行时代码只读取 `TRAINING_DB_ENABLED`、`TRAINING_DB_URL`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME`。 | `src/db/training/config.mjs:1-8` |
| main workflow 从 `secrets.TRAINING_DB_URL` 注入生产连接串，dev workflow 从 `secrets.DEV_TRAINING_DB_URL` 注入运行时 `TRAINING_DB_URL`。 | `.github/workflows/sync.yml:45-50`、`.github/workflows/sync-dev.yml:39-44`、`docs/01_系统配置/README.md` |
| `persistNormalizedBatch()` 连接后先执行 `ensureCoreSchema()`，再 `BEGIN` 写入业务数据。 | `src/db/training/write.mjs:72-100` |
| `export:markdown` 也会先执行 schema preflight，并且支持 `TRAINING_DB_PREFLIGHT_MAX_ATTEMPTS` / `TRAINING_DB_PREFLIGHT_RETRY_DELAY_MS`。 | `tools/export-training-markdown.mjs:58-94` |
| `ensureCoreSchema()` 包含 `ALTER TABLE`、`CREATE INDEX`、`CREATE TABLE ingest.ai_call_log` 等 DDL。 | `src/adapters/postgres/schema-preflight.pg.mjs:11-110` |
| 初始化脚本创建单一 `training_writer`，并对 `archive`、`ingest`、`core` 给予 `select, insert, update, delete`。 | `sql/pgsql17.sql:5-28`、`sql/pgsql17.sql:356-364`、`sql/pgsql17.sql:682-691` |
| 业务写入确实需要部分 `delete`：whole-day replacement 会删除目标日期的 `core.measurement/activity/meal/sleep`，睡眠增量写入也会删除同 identity 旧睡眠行。 | `src/adapters/postgres/core-day-repository.pg.mjs:221-224`、`src/adapters/postgres/core-row-writer.pg.mjs:444` |
| 日志规则已经要求 DB URL、token、password 不进入日志；DB summary 只保留安全摘要。 | `docs/02_系统核心逻辑/Action日志与失败补偿.md:52-63` |

## 目标状态

| 角色 | 用途 | 权限边界 |
| --- | --- | --- |
| `training_migrator` | 手动或 CI migration | 可以执行 DDL：`create/alter table`、`create index`、`comment`、必要的数据 backfill。不得用于日常同步。 |
| `training_app` | Telegram/飞书同步、常规 DB 写入、pending replay | 只允许必要的 DML。对 `core`/`ingest` 的 `delete` 只保留当前代码确实使用的表；不允许 DDL。 |
| `training_maintenance` | `sync:db`、`maintenance:migrate --confirm` 等显式维护 | 可比 `training_app` 多一些恢复所需 DML，但仍不执行 DDL。 |
| `training_readonly` | 站点构建、分析、只读巡检 | 只允许 `select`。构建读取需要覆盖 `core.*`，当前 sleep 查询还会 fallback 到 `archive.training_sleep`。 |

> 说明：角色名是目标建议，不是当前已存在配置。实现时要同步 `sql/pgsql17.sql`、`sql/training_records/*.sql` 和环境配置文档，避免文档提前声明已上线。

## 代码改动清单

### 1. 增加显式 migration 边界

- [ ] 新增正式迁移脚本目录，例如 `sql/training_records/migrations/` 或项目已有约定目录。
- [ ] 把 `schema-preflight.pg.mjs` 中所有 DDL 整理为一条或多条幂等 migration：
  - `core.sleep` 和 `core.training_day` 的睡眠字段。
  - `core.thought`、`ingest.telegram_message`、`ingest.telegram_recognition` 的 source identity 字段和唯一索引。
  - `ingest.ai_call_log`。
- [ ] 在 migration 文档中写清楚每条 migration 的前置检查 SQL、执行 SQL、回滚策略和验收 SQL。
- [ ] `tools/training-maintenance.mjs migrate --dry-run` 当前只输出固定计划；后续应能列出待执行 migration 和已执行状态。

### 2. 下线业务写入前 DDL

- [ ] `persistNormalizedBatch()` 不再默认执行 `ensureCoreSchema()`。
- [ ] `exportDerivedTrainingMarkdown()` 不再默认执行 DDL preflight；导出前只做只读 schema/version 检查。
- [ ] 过渡期如需保留兜底，必须用显式开关控制，且默认关闭。拟新增变量示例：`TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED=false`。
- [ ] 业务账号缺少 DDL 权限时，同步和导出不应因为 `ALTER TABLE` 权限失败而进入 `pending_replay`。

### 3. 拆分 DB 连接串

当前只有一个运行时 `TRAINING_DB_URL`。后续建议：

| 运行场景 | 当前配置 | 目标配置 |
| --- | --- | --- |
| main 同步 | `TRAINING_DB_URL` | `TRAINING_DB_URL` 指向 `training_app` 或 `training_maintenance`，不能是 migrator/superuser。 |
| dev 同步 | `DEV_TRAINING_DB_URL` 映射为 `TRAINING_DB_URL` | dev 使用独立 `training_app_dev`，继续保持与 main 物理隔离。 |
| migration | 当前没有独立 URL | 拟新增 `TRAINING_DB_MIGRATION_URL`，只在手动 migration workflow 或本地维护时使用。 |
| 只读构建 | 当前复用 `TRAINING_DB_URL` | 可选新增 `TRAINING_DB_READONLY_URL`；如果不加新变量，也要确保构建使用的账号只有 `select`。 |

新增变量前必须同步：

- `docs/01_系统配置/dev.md`
- `docs/01_系统配置/main.md`
- `.github/workflows/*.yml`
- `src/db/training/config.mjs` 或新增的 DB config 解析文件

## SQL 变更建议

### 角色与 grant

不要直接在生产库执行下面片段；这是目标形态草案，落地前要按真实数据库服务商语法和现有 owner 调整。

```sql
create role training_migrator login password '<强密码>';
create role training_app login password '<强密码>';
create role training_maintenance login password '<强密码>';
create role training_readonly login password '<强密码>';

grant usage on schema core, ingest, archive to training_app, training_maintenance, training_readonly;

grant select on all tables in schema core, ingest, archive to training_readonly;

grant select, insert, update on all tables in schema ingest to training_app;
grant select, insert, update on all tables in schema core to training_app;
grant delete on core.measurement, core.activity, core.meal, core.sleep to training_app;

grant select, insert, update, delete on all tables in schema ingest to training_maintenance;
grant select, insert, update, delete on all tables in schema core to training_maintenance;
grant select, insert, update on all tables in schema archive to training_maintenance;
```

审计注意：

- `training_app` 是否需要写 `archive.*` 取决于是否仍允许普通同步调用 `replaceCoreDay()` 的 archive 写入分支。
- `training_readonly` 需要能读取 `archive.training_sleep`，因为当前 `TRAINING_SLEEP_QUERY` 会从 `archive.training_sleep` fallback。
- 若使用 sequence，例如 `ingest.telegram_pending_batch_pending_id_seq`，对应角色还需要 `usage, select`。

### DDL owner

- [ ] schema owner 应由 migrator/owner 管理，不再由日常 app 账号持有。
- [ ] `revoke create on schema public from public` 保留。
- [ ] default privileges 要按新角色重新设置，不再把未来所有表自动授予过宽权限。

## 实现顺序

1. 在 dev 数据库创建新角色，保持旧 `training_writer` 不动。
2. 用 `TRAINING_DB_MIGRATION_URL` 或本地 migrator 账号执行迁移 dry-run。
3. 赋予 `training_app_dev` 最小权限，替换 `DEV_TRAINING_DB_URL`。
4. 跑 dev 同步、导出、构建、pending inspect、数据一致性检查。
5. 移除业务路径默认 DDL preflight，保留显式 migration。
6. 在 main 重复 2-5，确认无权限错误后再废弃旧 `training_writer`。

## 验收 Checklist

- [ ] dev/main 的普通 `TRAINING_DB_URL` 账号执行 `select current_user` 时不是 superuser/migrator。
- [ ] 普通同步账号执行 `create table`、`alter table`、`create index` 会失败。
- [ ] `npm run sync:telegram` 或 `npm run sync:feishu` 能完成 DB 写入，`persistenceResult.status` 为 `stored` 或 `unchanged`。
- [ ] `npm run sync:db` 能完成 safe 阶段；如需要 markdown phase，必须明确使用维护账号或确认 app 账号保留对应 delete 权限。
- [ ] `npm run export:markdown` 能从 DB 导出 Markdown，且不触发 DDL。
- [ ] `npm run maintenance:inspect` 可只读返回 pending 和 AI monitoring。
- [ ] `npm run check:data-consistency` 通过。
- [ ] Action summary 未出现 DB URL、SQL 参数、Secret 或用户正文。

## 回滚策略

- 保留旧 `training_writer` Secret 一轮发布周期，但不要在文档中记录明文。
- 如果新角色导致同步失败，先回滚 GitHub Secret 到旧连接串，再分析缺失 grant。
- 不要为了修复权限问题临时给业务账号 `create` 或 superuser；应补 migration 或精确 grant。
