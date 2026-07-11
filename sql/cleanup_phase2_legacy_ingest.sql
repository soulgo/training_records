-- 第二阶段旧 Ingest 表清理（破坏性、不可逆）
--
-- 不要在刚完成 migration_phase2_generic_ingest.sql 后立即执行。
-- 至少观察一个完整的同步、pending 重试、备份和维护周期，并确认新代码日志中旧表调用为 0。
-- 执行前必须完成数据库备份。
--
-- psql 手工执行示例：
--   begin;
--   set local training_records.allow_legacy_ingest_drop = 'on';
--   \i sql/cleanup_phase2_legacy_ingest.sql
--
-- 本文件自身会提交事务；如果通过其他客户端执行，请在同一连接开启事务并设置上述开关，
-- 然后只执行本文件从 DO $$ 开始的清理正文。不要把 psql 的 \i 元命令粘贴到普通 SQL 客户端。

do $$
declare
  legacy_batch_count bigint;
  generic_batch_count bigint;
  legacy_message_count bigint;
  generic_message_count bigint;
  legacy_recognition_count bigint;
  generic_recognition_count bigint;
  legacy_pending_count bigint;
  generic_pending_count bigint;
begin
  if coalesce(current_setting('training_records.allow_legacy_ingest_drop', true), '') <> 'on' then
    raise exception '拒绝删除旧 ingest 表：请先 SET LOCAL training_records.allow_legacy_ingest_drop = on';
  end if;

  if to_regclass('ingest.source_batch') is null
    or to_regclass('ingest.source_message') is null
    or to_regclass('ingest.recognition_run') is null
    or to_regclass('ingest.pending_task') is null then
    raise exception '通用 ingest 表不完整，禁止清理旧表';
  end if;

  select count(*) into legacy_batch_count from ingest.telegram_batch;
  select count(*) into generic_batch_count from ingest.source_batch;
  select count(*) into legacy_message_count from ingest.telegram_message;
  select count(*) into generic_message_count from ingest.source_message;
  select count(*) into legacy_recognition_count from ingest.telegram_recognition;
  select count(*) into generic_recognition_count from ingest.recognition_run;
  select count(*) into legacy_pending_count from ingest.telegram_pending_batch;
  select count(*) into generic_pending_count from ingest.pending_task;

  if generic_batch_count < legacy_batch_count then
    raise exception 'source_batch 数量少于旧 batch：new=%, old=%', generic_batch_count, legacy_batch_count;
  end if;
  if generic_message_count < legacy_message_count then
    raise exception 'source_message 数量少于旧 message：new=%, old=%', generic_message_count, legacy_message_count;
  end if;
  if generic_recognition_count < legacy_recognition_count then
    raise exception 'recognition_run 数量少于旧 recognition：new=%, old=%', generic_recognition_count, legacy_recognition_count;
  end if;
  if generic_pending_count < legacy_pending_count then
    raise exception 'pending_task 数量少于旧 pending：new=%, old=%', generic_pending_count, legacy_pending_count;
  end if;

  if exists (
    select 1
    from ingest.recognition_run r
    left join ingest.source_message m using (source_channel, source_chat_id, source_message_id)
    where m.source_message_id is null
  ) then
    raise exception 'recognition_run 存在孤儿消息引用，禁止清理旧表';
  end if;
end
$$;

drop table if exists ingest.telegram_recognition;
drop table if exists ingest.telegram_message;
drop table if exists ingest.telegram_pending_batch;
drop table if exists ingest.telegram_batch;
drop sequence if exists ingest.telegram_pending_batch_pending_id_seq;

commit;

-- 验收：以下对象应为空，generic 表必须仍存在。
-- select to_regclass('ingest.telegram_batch') as legacy_batch;
-- select to_regclass('ingest.telegram_message') as legacy_message;
-- select to_regclass('ingest.telegram_recognition') as legacy_recognition;
-- select to_regclass('ingest.telegram_pending_batch') as legacy_pending;
-- select to_regclass('ingest.source_batch') as source_batch;
-- select to_regclass('ingest.source_message') as source_message;
-- select to_regclass('ingest.recognition_run') as recognition_run;
-- select to_regclass('ingest.pending_task') as pending_task;

-- 回滚说明：DROP 后无法通过 SQL 原地回滚；只能从执行前备份恢复旧表。
