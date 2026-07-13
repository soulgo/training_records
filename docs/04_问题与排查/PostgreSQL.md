# PostgreSQL

## 现象

- 同步结果出现 `persistenceStatus: pending_replay`。
- `npm run build:data` 无法从 database 生成快照。
- Actions summary 显示 database 相关失败。

## 原因

- `TRAINING_DB_ENABLED` 未为 `true`。
- `TRAINING_DB_URL` / `DEV_TRAINING_DB_URL` 缺失或不可连接。
- schema 与代码不一致，尚未在目标环境手工执行更新 SQL。
- GitHub Settings 中的分支数据库 Secret 指向了错误数据库，或 URL 未使用约定的 `training_writer` 写账号。
- 读取型任务未配置 `TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL`，只能回退写入连接。
- 连接超时由 `TRAINING_DB_TIMEOUT_MS` 控制。

## 日志特征

- `[training-db] rollback failed`
- `[telegram-sync] queued database replay`
- `database snapshot unavailable`
- `persistenceStatus: pending_replay`
- `database.permissionAudit.isSuperuser=true`
- `database.permissionAudit.isMigratorLikeUser=true`
- `database.permissionAudit.schemaCreatePrivileges`

## 排查步骤

1. 核对 workflow env：`sync.yml` / `sync-dev.yml` 中 `TRAINING_DB_*` 必须来自 GitHub Settings/Secrets；main/dev 写 URL 都使用 `training_writer`，但指向各自数据库。
2. 核对代码读取：`src/db/training/config.mjs`。
3. 核对写入入口：`src/db/training/write.mjs:21`。
4. 核对 schema：dev 使用 `sql/dev-sql/`，main 使用 `sql/main-sql/`。
5. dev/main 已完成结构对齐；后续 schema 变化先在目标环境备份、独立执行和验收，再重新导出对应 `sql/<environment>-sql/` 文件。
6. 运行 `npm run maintenance:inspect`，检查 `database.permissionAudit`：`training_writer` 的 schema `CREATE` 是当前受控 DDL 模型的预期能力；superuser、migrator-like 用户或其他账号的 schema `CREATE` 仍应进入危险原因。
7. 运行 `npm run check:data-consistency`。

## 解决方案

- 补齐对应环境的数据库 Secret。
- 先备份目标数据库，再使用 `training_writer` 或数据库管理员执行对应环境的受控更新 SQL和验收查询，随后重跑同步并重新导出环境 schema。
- 为读取型任务配置 `TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL`。
- 对 `pending_replay` 批次，修复 DB 后通过同步流程重放。
- 若报错缺少 `ingest.source_batch`、`source_message`、`source_asset`、`recognition_run`、`pending_task` 或分析画像表，说明目标数据库结构与当前代码不一致；从对应环境导出和实际 schema 核对后受控补齐，不能通过恢复旧 repository 绕过。

## 预防措施

- 改 SQL 时同步 repository、环境 schema 导出、当前文档和测试。
- main/dev 使用 GitHub Settings 中各自的数据库连接串，写连接统一使用 `training_writer`。
- 日常 workflow 不执行 DDL；结构 DDL 由 `training_writer` 或管理员在目标环境受控执行并重新导出对应环境 SQL。
- 不在日常业务路径中恢复运行时 DDL 或 schema preflight。
- 不把 Markdown fallback 成功误判为 database 成功。
