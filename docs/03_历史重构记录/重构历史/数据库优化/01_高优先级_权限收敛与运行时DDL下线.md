# 高优先级：权限收敛与运行时 DDL 下线

> 优先级：高
> 状态：已实现并从 `后续规划_未实现/数据库优化/` 移入重构历史。当前操作事实以 `docs/01_系统配置/`、`docs/02_系统核心逻辑/数据库模型.md`、`docs/02_系统核心逻辑/数据入库流程.md` 和 `docs/04_问题与排查/PostgreSQL.md` 为准。
> 目标：降低 PostgreSQL 被误用或被攻破后的破坏半径。业务运行账号只做业务读写，DDL 和 schema 迁移只能由显式迁移账号执行。

## 当前证据

| 事实 | 证据 |
| --- | --- |
| 运行时代码读取 `TRAINING_DB_ENABLED`、`TRAINING_DB_URL`、`TRAINING_DB_READONLY_URL`、`TRAINING_DB_TIMEOUT_MS`、`TRAINING_DB_APP_NAME` 和显式 `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED`。 | `src/db/training/config.mjs` |
| main workflow 从 `secrets.TRAINING_DB_URL` / `secrets.TRAINING_DB_READONLY_URL` 注入生产连接串，dev workflow 从 `secrets.DEV_TRAINING_DB_URL` / `secrets.DEV_TRAINING_DB_READONLY_URL` 注入运行时连接串。 | `.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml`、`.github/workflows/deploy-pages.yml`、`.github/workflows/deploy-cloudflare-pages-dev.yml`、`.github/workflows/markdown-backup.yml`、`docs/01_系统配置/README.md` |
| `persistNormalizedBatch()` 默认直接进入业务事务；只有 `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED=true` 时才执行 `ensureCoreSchema()`。 | `src/db/training/write.mjs`、`test/training-db-core.test.mjs` |
| `export:markdown` 默认不执行 schema preflight；只有显式开关开启时才保留过渡期重试 preflight。 | `tools/export-training-markdown.mjs`、`test/export-training-markdown.test.mjs` |
| `ensureCoreSchema()` 包含 `ALTER TABLE`、`CREATE INDEX`、`CREATE TABLE ingest.ai_call_log` 等 DDL。 | `src/adapters/postgres/schema-preflight.pg.mjs:11-110` |
| 初始化脚本已拆分 `training_migrator`、`training_app`、`training_maintenance`、`training_readonly`，schema owner、migration history 与 default privileges 由 migrator 管理。 | `sql/pgsql17.sql`、`test/training-db-archive.test.mjs` |
| `maintenance:inspect` 会优先使用 `TRAINING_DB_READONLY_URL` 查看 pending、AI monitoring、单批次审计和权限摘要，并用只读 SQL 输出当前 DB 用户、superuser 标记、migrator-like 标记和各 schema 的 `CREATE` 权限，辅助 dev/main 权限验收。 | `tools/training-maintenance.mjs`、`src/db/training/pending-recognition.mjs`、`test/training-maintenance.test.mjs` |
| 业务写入确实需要部分 `delete`：whole-day replacement 会删除目标日期的 `core.measurement/activity/meal/sleep`，睡眠增量写入也会删除同 identity 旧睡眠行。 | `src/adapters/postgres/core-day-repository.pg.mjs:221-224`、`src/adapters/postgres/core-row-writer.pg.mjs:444` |
| 日志规则已经要求 DB URL、token、password 不进入日志；DB summary 只保留安全摘要。 | `docs/02_系统核心逻辑/Action日志与失败补偿.md:52-63` |

## 目标状态

| 角色 | 用途 | 权限边界 |
| --- | --- | --- |
| `training_migrator` | 手动或 CI migration | 可以执行 DDL：`create/alter table`、`create index`、`comment`、必要的数据 backfill。不得用于日常同步。 |
| `training_app` | Telegram/飞书同步、常规 DB 写入、pending replay | 只允许必要的 DML。对 `core`/`ingest` 的 `delete` 只保留当前代码确实使用的表；不允许 DDL。 |
| `training_maintenance` | `sync:db` 等显式维护 | 可比 `training_app` 多一些恢复所需 DML，但仍不执行 DDL。`maintenance:migrate --confirm` 必须显式使用 migration URL。 |
| `training_readonly` | 站点构建、分析、只读巡检 | 只允许 `select`。构建读取需要覆盖 `core.*`，当前 sleep 查询还会 fallback 到 `archive.training_sleep`。 |

> 说明：角色名已进入初始化脚本；真实 dev/main 数据库和 GitHub Secrets 是否已切换仍需按验收 Checklist 单独验证，不能仅凭仓库代码视为已上线。

## 代码改动清单

### 1. 增加显式 migration 边界

- [x] 新增正式迁移脚本目录，例如 `sql/training_records/migrations/` 或项目已有约定目录。
- [x] 把 `schema-preflight.pg.mjs` 中所有 DDL 整理为一条或多条幂等 migration：
  - `core.sleep` 和 `core.training_day` 的睡眠字段。
  - `core.thought`、`ingest.telegram_message`、`ingest.telegram_recognition` 的 source identity 字段和唯一索引。
  - `ingest.ai_call_log`。
- [x] 在 migration 文档中写清楚每条 migration 的前置检查 SQL、执行 SQL、回滚策略和验收 SQL。
- [x] `tools/training-maintenance.mjs migrate --dry-run` 能列出 migration 文件；配置 `TRAINING_DB_MIGRATION_URL` 时会读取 `maintenance.schema_migration` 并标出 `applied` / `pending` / `checksum_mismatch` 状态。

### 2. 下线业务写入前 DDL

- [x] `persistNormalizedBatch()` 不再默认执行 `ensureCoreSchema()`。
- [x] `exportDerivedTrainingMarkdown()` 不再默认执行 DDL preflight；默认只走严格数据库快照读取，schema 不匹配由只读查询失败暴露。
- [x] 过渡期如需保留兜底，必须用显式开关控制，且默认关闭。拟新增变量示例：`TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED=false`。
- [x] 业务账号缺少 DDL 权限时，同步和导出不应因为 `ALTER TABLE` 权限失败而进入 `pending_replay`。

### 3. 拆分 DB 连接串

当前写入路径仍以运行时 `TRAINING_DB_URL` 为主；读取快照、pending summary、AI monitoring、单批次审计、权限审计和数据一致性检查已支持可选 `TRAINING_DB_READONLY_URL`，未配置时回退 `TRAINING_DB_URL`。workflow 已注入 main/dev 的只读 Secret。其余连接串拆分后续建议：

| 运行场景 | 当前配置 | 目标配置 |
| --- | --- | --- |
| main 同步 | `TRAINING_DB_URL` | `TRAINING_DB_URL` 指向 `training_app` 或 `training_maintenance`，不能是 migrator/superuser。 |
| dev 同步 | `DEV_TRAINING_DB_URL` 映射为 `TRAINING_DB_URL`；`DEV_TRAINING_DB_READONLY_URL` 映射为 `TRAINING_DB_READONLY_URL` | dev 使用独立 `training_app_dev` / `training_readonly_dev`，继续保持与 main 物理隔离。 |
| migration | `TRAINING_DB_MIGRATION_URL` 已支持，且 `maintenance:migrate --confirm` 缺少该变量时会阻断 | 只在手动 migration workflow 或本地维护时使用，不注入日常同步 workflow。 |
| 只读构建 | `TRAINING_DB_READONLY_URL` 可选；未配置时回退 `TRAINING_DB_URL` | 推荐配置只读账号；如果不加新变量，也要确保构建使用的账号只有 `select`。 |

新增变量前必须同步：

- `docs/01_系统配置/dev.md`
- `docs/01_系统配置/main.md`
- `.github/workflows/*.yml`
- `src/db/training/config.mjs` 或新增的 DB config 解析文件

当前状态：`TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL` 已同步到读取型 workflow；`TRAINING_DB_MIGRATION_URL` 已同步配置文档和维护入口，但不进入日常 workflow。

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
grant select, insert, update on archive.training_parse_snapshot, archive.training_sleep to training_app;

grant select, insert, update, delete on all tables in schema ingest to training_maintenance;
grant select, insert, update, delete on all tables in schema core to training_maintenance;
grant select, insert, update on all tables in schema archive to training_maintenance;
```

审计注意：

- `training_app` 当前只保留 `archive.training_parse_snapshot` 和 `archive.training_sleep` 的 `select/insert/update`，对应普通同步调用 `replaceCoreDay()` 时的 archive snapshot/sleep 兼容写入；不得授予整个 `archive.*` 的宽泛 DML。
- `training_readonly` 需要能读取 `archive.training_sleep`，因为当前 `TRAINING_SLEEP_QUERY` 会从 `archive.training_sleep` fallback。
- 若使用 sequence，例如 `ingest.telegram_pending_batch_pending_id_seq`，对应角色还需要 `usage, select`。

当前状态：`sql/pgsql17.sql` 已按上述角色拆分初始化脚本；真实 dev/main 数据库仍需按验收 Checklist 执行角色创建、Secret 切换和权限验证。

### Migration history

- [x] 新增 `maintenance.schema_migration` 记录显式 migration 执行历史。
- [x] `maintenance:migrate --confirm` 执行前会创建 history 表、跳过已记录的 migration，并在成功执行后写入 checksum 与执行时间。
- [x] 已记录 migration 的 checksum 与当前 SQL 文件不一致时，`maintenance:migrate --dry-run` 标记 `checksum_mismatch`，`--confirm` 阻断执行，避免同名 migration 静默漂移。
- [x] 日常 `training_app` 不授予 `maintenance.schema_migration` 权限，避免业务路径读写迁移元数据。

### DDL owner

- [x] schema owner 应由 migrator/owner 管理，不再由日常 app 账号持有。
- [x] `revoke create on schema public from public` 保留。
- [x] default privileges 要按新角色重新设置，不再把未来所有表自动授予过宽权限。

### Permission audit

- [x] `maintenance:inspect` 优先使用 `TRAINING_DB_READONLY_URL` 读取 pending summary、AI monitoring、单批次审计和 `database.permissionAudit`；只使用业务读取 SQL、`select current_user`、`pg_roles` 和 `has_schema_privilege()` 等只读查询。
- [x] `check:data-consistency` 优先使用 `TRAINING_DB_READONLY_URL`，只执行一致性读取和 `information_schema` 查询。
- [x] 权限审计摘要只包含 `currentUser`、`sessionUser`、`isSuperuser`、`isMigratorLikeUser`、各 schema `CREATE` 权限和危险原因，不输出 DB URL、SQL 参数或 Secret。
- [x] DB 未配置或权限审计查询失败时不影响 pending / AI monitoring 巡检主结果。

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
