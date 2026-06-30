-- id: 001_runtime_schema_preflight_backfill
-- purpose: Move historical runtime schema preflight DDL into an explicit migration.
-- execute with: TRAINING_DB_MIGRATION_URL or a schema owner/migrator account, never the daily app account.

begin;

alter table core.sleep add column if not exists total_sleep_minutes integer null;
alter table core.sleep add column if not exists sleep_score integer null;
alter table core.sleep add column if not exists sleep_score_percentile integer null;
alter table core.sleep add column if not exists deep_sleep_continuity_score integer null;
alter table core.sleep add column if not exists wake_count integer null;
alter table core.sleep add column if not exists breathing_quality_score integer null;
alter table core.sleep add column if not exists average_heart_rate_bpm integer null;
alter table core.sleep add column if not exists hrv_ms integer null;
alter table core.sleep add column if not exists average_spo2_pct numeric(10, 2) null;
alter table core.sleep add column if not exists average_respiratory_rate numeric(10, 2) null;
alter table core.sleep add column if not exists analysis_text text null;
alter table core.sleep add column if not exists suggestion_text text null;

alter table core.training_day add column if not exists sleep_total_minutes integer null;
alter table core.training_day add column if not exists night_sleep_minutes integer null;
alter table core.training_day add column if not exists nap_minutes integer null;
alter table core.training_day add column if not exists sleep_start_time text null;
alter table core.training_day add column if not exists sleep_end_time text null;
alter table core.training_day add column if not exists deep_sleep_minutes integer null;
alter table core.training_day add column if not exists light_sleep_minutes integer null;
alter table core.training_day add column if not exists rem_sleep_minutes integer null;
alter table core.training_day add column if not exists awake_minutes integer null;

alter table core.thought add column if not exists source_channel text null;
alter table core.thought add column if not exists source_chat_id text null;
alter table core.thought add column if not exists source_message_id text null;
comment on column core.thought.source_channel is '来源通道，例如 telegram、feishu、markdown_import';
comment on column core.thought.source_chat_id is '来源 chat/conversation ID，Telegram 为 chat_id，飞书为 chat_id 原始字符串';
comment on column core.thought.source_message_id is '来源消息 ID，Telegram 为 message_id，飞书为 message_id 原始字符串';
update core.thought
set source_channel = coalesce(source_channel, 'telegram'),
    source_chat_id = coalesce(source_chat_id, telegram_chat_id::text, 'legacy-chat'),
    source_message_id = coalesce(source_message_id, telegram_message_id::text)
where source_channel is null
   or source_chat_id is null
   or source_message_id is null;
alter table core.thought alter column source_channel set default 'telegram';
alter table core.thought alter column source_channel set not null;
alter table core.thought alter column source_chat_id set default 'legacy-chat';
alter table core.thought alter column source_chat_id set not null;
alter table core.thought alter column source_message_id set not null;
create unique index if not exists ux_core_thought_identity
on core.thought(source_channel, source_chat_id, source_message_id);

alter table ingest.telegram_message add column if not exists source_channel text not null default 'telegram';
alter table ingest.telegram_message add column if not exists source_chat_id text null;
alter table ingest.telegram_message add column if not exists source_message_id text null;
update ingest.telegram_message
set source_chat_id = coalesce(source_chat_id, chat_id::text, 'legacy-chat'),
    source_message_id = coalesce(source_message_id, message_id::text)
where source_chat_id is null
   or source_message_id is null;
alter table ingest.telegram_message alter column source_chat_id set default 'legacy-chat';
alter table ingest.telegram_message alter column source_chat_id set not null;
alter table ingest.telegram_message alter column source_message_id set not null;
create unique index if not exists ux_ingest_telegram_message_source_identity
on ingest.telegram_message(source_channel, source_chat_id, source_message_id);

alter table ingest.telegram_recognition add column if not exists source_channel text not null default 'telegram';
alter table ingest.telegram_recognition add column if not exists source_chat_id text null;
alter table ingest.telegram_recognition add column if not exists source_message_id text null;
update ingest.telegram_recognition recognition
set source_chat_id = coalesce(recognition.source_chat_id, message.source_chat_id, recognition.message_id::text),
    source_message_id = coalesce(recognition.source_message_id, message.source_message_id, recognition.message_id::text),
    source_channel = coalesce(recognition.source_channel, message.source_channel, 'telegram')
from ingest.telegram_message message
where message.message_id = recognition.message_id
  and (recognition.source_chat_id is null or recognition.source_message_id is null);
update ingest.telegram_recognition
set source_chat_id = coalesce(source_chat_id, 'legacy-chat'),
    source_message_id = coalesce(source_message_id, message_id::text)
where source_chat_id is null
   or source_message_id is null;
alter table ingest.telegram_recognition alter column source_chat_id set default 'legacy-chat';
alter table ingest.telegram_recognition alter column source_chat_id set not null;
alter table ingest.telegram_recognition alter column source_message_id set not null;
create unique index if not exists ux_ingest_telegram_recognition_source_identity
on ingest.telegram_recognition(source_channel, source_chat_id, source_message_id);

create table if not exists ingest.ai_call_log (
  ai_call_id text primary key,
  task_id text null,
  scene text not null,
  provider text not null,
  model text not null,
  prompt_version text null,
  idempotency_key text null,
  status text not null,
  latency_ms integer null,
  failure_category text null,
  failure_reason text null,
  prompt_tokens integer null,
  completion_tokens integer null,
  total_tokens integer null,
  cost_usd numeric(12, 6) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

commit;
