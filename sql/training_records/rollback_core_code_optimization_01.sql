-- Rollback helpers for docs/优化重构/核心代码优化01 database additive changes.
-- Review and run statements selectively in dev before any production rollback.
-- This script intentionally preserves legacy ingest.telegram_* and core.* data tables.

begin;

-- AI audit table is additive and not required by the legacy sync path.
drop table if exists ingest.ai_call_log;

-- Source-identity indexes are additive compatibility indexes. Dropping them
-- reverts lookup pressure without deleting source identity columns or data.
drop index if exists ux_ingest_telegram_recognition_source_identity;
drop index if exists ux_ingest_telegram_message_source_identity;
drop index if exists ux_core_thought_identity;

-- Keep source identity columns for audit and forward migration. If rollback
-- requires disabling new reads, switch application code/config back to legacy
-- telegram_message_id and ingest.telegram_* paths instead of dropping columns.

commit;
