-- =============================================================================
-- 用途：清理 ingest schema 下的遗留 telegram_* 表与序列（对应重构方案 R6）
-- 背景：新主链路已改用来源无关表 source_batch / source_message /
--       recognition_run / pending_task，四张 telegram_* 表在 src/ 中无表引用。
-- 执行者：training_writer 或 DBA，在 dev 数据库手动执行；日常 workflow 不做 DDL。
-- 环境：dev 与 main 分别独立执行，不混写业务数据。本文件仅针对 dev。
-- 不可逆：以下为 DROP 操作，执行前请先完成第 1 步核对。
--
-- 执行顺序（先子表/依赖，后主表与序列）：
--   1. 人工核对：确认无外部对象依赖、历史数据无需保留
--   2. DROP telegram_recognition（依赖 message、batch）
--   3. DROP telegram_message（依赖 batch）
--   4. DROP telegram_batch
--   5. DROP telegram_pending_batch
--   6. DROP 序列 telegram_pending_batch_pending_id_seq
--   7. 执行后重新导出 sql/dev-sql 并运行 check:data-consistency
-- =============================================================================

-- 步骤 1：执行前核对（手动运行，确认返回结果符合预期后再继续）
-- 1a. 确认没有其他对象依赖这些表（外键、视图等）；预期只返回四张表之间的内部外键。
--     SELECT conrelid::regclass AS child, confrelid::regclass AS parent, conname
--     FROM pg_constraint
--     WHERE confrelid::regclass::text LIKE 'ingest.telegram_%';
-- 1b. 确认历史数据是否需要保留（如需备份，先自行 dump）。
--     SELECT 'telegram_batch' AS t, count(*) FROM ingest.telegram_batch
--     UNION ALL SELECT 'telegram_message', count(*) FROM ingest.telegram_message
--     UNION ALL SELECT 'telegram_recognition', count(*) FROM ingest.telegram_recognition
--     UNION ALL SELECT 'telegram_pending_batch', count(*) FROM ingest.telegram_pending_batch;

BEGIN;

-- 步骤 2：先删依赖 message/batch 的子表
DROP TABLE IF EXISTS "ingest"."telegram_recognition";

-- 步骤 3：删依赖 batch 的 message 表
DROP TABLE IF EXISTS "ingest"."telegram_message";

-- 步骤 4：删 batch 主表
DROP TABLE IF EXISTS "ingest"."telegram_batch";

-- 步骤 5：删 pending_batch 表（独立，无外键约束到上述表）
DROP TABLE IF EXISTS "ingest"."telegram_pending_batch";

-- 步骤 6：删 pending_batch 对应序列
DROP SEQUENCE IF EXISTS "ingest"."telegram_pending_batch_pending_id_seq";

COMMIT;

-- 步骤 7（执行完成后，在仓库侧操作）：
--   - 重新从 dev 数据库导出 sql/dev-sql/ingest.sql
--   - 运行 npm run check:data-consistency
