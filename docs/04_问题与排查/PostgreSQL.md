# PostgreSQL

## 现象

- 同步结果出现 `persistenceStatus: pending_replay`。
- `npm run build:data` 无法从 database 生成快照。
- Actions summary 显示 database 相关失败。

## 原因

- `TRAINING_DB_ENABLED` 未为 `true`。
- `TRAINING_DB_URL` / `DEV_TRAINING_DB_URL` 缺失或不可连接。
- schema 与代码不一致，尚未通过显式 migration 执行。
- 日常业务账号被错误授予或错误使用 DDL 权限，或 migration 账号误注入日常 workflow。
- 读取型任务未配置 `TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL`，只能回退写入连接。
- 连接超时由 `TRAINING_DB_TIMEOUT_MS` 控制。

## 日志特征

- `[training-db] rollback failed`
- `[telegram-sync] queued database replay`
- `database snapshot unavailable`
- `persistenceStatus: pending_replay`
- `migrate --confirm requires TRAINING_DB_MIGRATION_URL`
- `database.permissionAudit.isSuperuser=true`
- `database.permissionAudit.isMigratorLikeUser=true`
- `database.permissionAudit.schemaCreatePrivileges`

## 排查步骤

1. 核对 workflow env：`sync.yml` / `sync-dev.yml` 中 `TRAINING_DB_*`，确认日常 workflow 没有注入 `TRAINING_DB_MIGRATION_URL`。
2. 核对代码读取：`src/db/training/config.mjs`。
3. 核对写入入口：`src/db/training/write.mjs:21`。
4. 核对 schema：`sql/pgsql17.sql`、`sql/training_records/migrations/`、`sql/migration.sql` 与 `sql/migration_phase2_generic_ingest.sql`。
5. 本地先运行 `npm run maintenance:migrate -- --dry-run`；远端先手动运行 `Training Database Migration` 的 `dry-run`。确认 checksum 和 pending 列表后，才执行对应入口的 `confirm`。
6. 运行 `npm run maintenance:inspect`，检查 `database.permissionAudit` 中的 superuser、migrator-like 和 schema `CREATE` 权限摘要。
7. 运行 `npm run check:data-consistency`。

## 解决方案

- 补齐对应环境的数据库 Secret。
- 先用迁移账号执行 schema migration，再重跑同步；不要临时给日常业务账号 `CREATE`、migrator 或 superuser 权限。
- 远端 migration workflow 只能手动触发；禁止把 `DEV_TRAINING_DB_MIGRATION_URL` 或 `TRAINING_DB_MIGRATION_URL` 注入日常 sync/deploy job。
- 为读取型任务配置 `TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL`。
- 对 `pending_replay` 批次，修复 DB 后通过同步流程重放。
- 若报错缺少 `ingest.source_batch`、`source_message`、`source_asset`、`recognition_run` 或 `pending_task`，说明 Phase 2 未执行；先备份并手工执行两阶段迁移，不能通过临时恢复旧 repository 绕过。

## 预防措施

- 改 SQL 时同步 repository、migration 和测试。
- main/dev 使用独立数据库连接串。
- 日常同步账号只做业务 DML；DDL 只通过 `maintenance:migrate` 和 migration URL 执行。
- 不在日常业务路径中恢复运行时 DDL 或 schema preflight。
- 不把 Markdown fallback 成功误判为 database 成功。
- 不自动执行 `sql/cleanup_phase2_legacy_ingest.sql`；只有观察完整同步/重试周期且旧表调用与数据计数验收通过后才人工开启清理门禁。
