# PostgreSQL

## 现象

- 同步结果出现 `persistenceStatus: pending_replay`。
- `npm run build:data` 无法从 database 生成快照。
- Actions summary 显示 database 相关失败。

## 原因

- `TRAINING_DB_ENABLED` 未为 `true`。
- `TRAINING_DB_URL` / `DEV_TRAINING_DB_URL` 缺失或不可连接。
- schema 与代码不一致，`ensureCoreSchema` 或 SQL 写入失败。
- 连接超时由 `TRAINING_DB_TIMEOUT_MS` 控制。

## 日志特征

- `[training-db] rollback failed`
- `[telegram-sync] queued database replay`
- `database snapshot unavailable`
- `persistenceStatus: pending_replay`

## 排查步骤

1. 核对 workflow env：`sync.yml` / `sync-dev.yml` 中 `TRAINING_DB_*`。
2. 核对代码读取：`src/db/training/config.mjs:1-8`。
3. 核对写入入口：`src/db/training/write.mjs:21`。
4. 核对 schema：`sql/pgsql17.sql` 与 `src/adapters/postgres/schema-preflight.pg.mjs`。
5. 运行 `npm run check:data-consistency`。

## 解决方案

- 补齐对应环境的数据库 Secret。
- 先执行 schema 迁移，再重跑同步。
- 对 `pending_replay` 批次，修复 DB 后通过同步流程重放。

## 预防措施

- 改 SQL 时同步 repository、preflight 和测试。
- main/dev 使用独立数据库连接串。
- 不把 Markdown fallback 成功误判为 database 成功。
