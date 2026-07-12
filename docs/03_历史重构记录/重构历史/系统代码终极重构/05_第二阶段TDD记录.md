# Hai TDD: 通用 Ingest 与来源身份收口（历史验证记录）

## Target Behavior
Telegram 与飞书消息、资源、识别结果和 pending 任务使用来源无关的数据库表；旧 numeric ID 只能作为迁移核对字段，不能作为 generic 主键或缓存身份。

## RED 1：Schema 字段归属
- **Test added**: `ingest schema keeps normalized recognition columns on telegram_recognition, not telegram_message`
- **Behavior asserted**: `source_app/data_type/fields_json/...` 必须属于 recognition 表。
- **Command**: `node --test --test-name-pattern='keeps normalized recognition columns' test/generic-ingest-migration.test.mjs`
- **Observed failure**: `source_app does not belong to telegram_message`。
- **Failure is correct because**: 测试读取了真实 canonical SQL，准确证明上一阶段字段被写入错误表。

## GREEN 1
- **Minimal implementation**: 从 `telegram_message` 移除 8 个识别列，添加到 `telegram_recognition` 并保留中文注释。
- **Command**: 同上。
- **Observed pass**: 1/1 通过。

## REFACTOR 1
- **Refactor done**: no
- **Change**: 只修复字段归属，未混入 generic 表设计。
- **Command after refactor**: not needed
- **Observed result**: schema contract 为绿。

## RED 2：Generic migration
- **Test added**: `phase 2 migration creates and backfills generic ingest tables without dropping legacy tables`
- **Behavior asserted**: migration 必须创建、注释、索引和回填 generic 表，且不得 DROP 旧表。
- **Command**: `node --test --test-name-pattern='phase 2 migration creates' test/generic-ingest-migration.test.mjs`
- **Observed failure**: `ENOENT migration_phase2_generic_ingest.sql`。
- **Failure is correct because**: 所需人工迁移文件尚不存在。

## GREEN 2
- **Minimal implementation**: 新增 `migration_phase2_generic_ingest.sql`，创建并回填 `source_batch/source_message/source_asset/recognition_run/pending_task`。
- **Command**: `node --test test/generic-ingest-migration.test.mjs`
- **Observed pass**: migration contract 通过。

## REFACTOR 2
- **Refactor done**: yes
- **Change**: 同步 `pgsql17.sql` 与 `training_records/ingest.sql`，防止 migration 与初始化 schema 再次漂移。
- **Command after refactor**: `node --test test/generic-ingest-migration.test.mjs`
- **Observed result**: canonical schema 与 migration 一致。

## RED 3：Generic repository
- **Test added**: `PostgresSourceBatchRepository persists generic batch, message, asset, and recognition records`
- **Behavior asserted**: 仓储只写 generic 表，识别 SQL 不写 legacy `message_id`。
- **Command**: `node --test --test-name-pattern='PostgresSourceBatchRepository' test/core-repositories.test.mjs`
- **Observed failure**: 模块没有导出 `PostgresSourceBatchRepository`。
- **Failure is correct because**: 生产仓储仍为 Telegram 命名和旧表实现。

## GREEN 3
- **Minimal implementation**: 新增来源无关仓储；切换 batch/message/asset/recognition 写入、cache read、last Telegram offset、维护审计和一致性检查。
- **Command**: `node --test test/core-repositories.test.mjs test/ai-recognition-service.test.mjs test/training-db-core.test.mjs`
- **Observed pass**: 105/105 通过。

## REFACTOR 3
- **Refactor done**: yes
- **Change**: 删除 `telegram-batch-repository.pg.mjs`；将睡眠修复、AI monitoring、batch audit 和 pending queue 全部切到 generic 表。
- **Command after refactor**: `rg -n "ingest\\.telegram_(batch|message|recognition|pending_batch)" src tools cloudflare`
- **Observed result**: 生产代码扫描无匹配。

## RED 4：受保护的旧表清理
- **Test added**: `legacy ingest cleanup is guarded and drops old tables only after count checks`
- **Behavior asserted**: cleanup 必须显式开关、计数/孤儿校验、备份警告和有序 DROP。
- **Command**: `node --test --test-name-pattern='legacy ingest cleanup' test/generic-ingest-migration.test.mjs`
- **Observed failure**: cleanup SQL 不存在。
- **Failure is correct because**: 尚无安全退役门禁。

## GREEN 4
- **Minimal implementation**: 新增 `cleanup_phase2_legacy_ingest.sql`；默认拒绝执行，只有同连接显式设置开关且校验通过才删除旧表。
- **Command**: `node --test test/generic-ingest-migration.test.mjs`
- **Observed pass**: 4/4 通过。

## REFACTOR 4
- **Refactor done**: no
- **Change**: cleanup 保持独立文件，不与非破坏性 migration 合并。
- **Command after refactor**: `npm test`
- **Observed result**: 当前全量回归 763/763 通过。

## Next Behavior
在真实环境手工执行 Phase 1、Phase 2 migration 并观察至少一个完整同步/重试周期；验证后再决定是否执行 cleanup SQL。`core.thought` 的 numeric 兼容字段属于下一独立迁移，不在本阶段破坏性删除。
