-- 第二阶段：来源无关的 Ingest 数据模型
-- 执行顺序：
--   1. 先执行 sql/migration.sql（为旧 recognition 表补齐标准化列）。
--   2. 再执行本文件。
--   3. 验收通过后部署读取/写入 generic ingest 表的新代码。
-- 本迁移只新增并回填，不删除旧 ingest.telegram_* 表，便于人工核对和回滚。

begin;

do $$
begin
  if to_regclass('ingest.telegram_batch') is null
    or to_regclass('ingest.telegram_message') is null
    or to_regclass('ingest.telegram_recognition') is null then
    raise exception '缺少旧 ingest.telegram_* 表，无法执行通用 ingest 回填';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'ingest'
      and table_name = 'telegram_recognition'
      and column_name = 'cache_key'
  ) then
    raise exception '请先执行 sql/migration.sql，再执行本迁移';
  end if;
end
$$;

create table if not exists ingest.source_batch (
  source_channel text not null,
  batch_id text not null,
  kind text not null default 'image',
  status text not null,
  archived_date date,
  reason text,
  confidence numeric(5,4),
  warnings_json jsonb not null default '[]'::jsonb,
  issues_json jsonb not null default '[]'::jsonb,
  payload_hash text not null,
  payload_json jsonb not null,
  processed_at timestamptz not null,
  updated_at timestamptz not null,
  constraint source_batch_pkey primary key (source_channel, batch_id),
  constraint ck_source_batch_confidence check (confidence is null or (confidence >= 0 and confidence <= 1))
);

comment on table ingest.source_batch is '来源无关的消息处理批次；替代以 Telegram 命名的批次主表';
comment on column ingest.source_batch.source_channel is '来源渠道，例如 telegram、feishu 或未来新增渠道';
comment on column ingest.source_batch.batch_id is '来源渠道内稳定的批次标识';
comment on column ingest.source_batch.kind is '批次类型，例如 image、thought、analysis';
comment on column ingest.source_batch.status is '批次业务处理状态';
comment on column ingest.source_batch.payload_hash is '用于幂等判断的批次内容摘要';
comment on column ingest.source_batch.payload_json is '来源无关的标准化批次快照';

create table if not exists ingest.source_message (
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  batch_id text not null,
  source_event_id text,
  legacy_message_id bigint,
  legacy_update_id bigint,
  media_group_id text,
  sent_at timestamptz,
  caption text not null default '',
  message_text text not null default '',
  payload_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null,
  constraint source_message_pkey primary key (source_channel, source_chat_id, source_message_id),
  constraint source_message_batch_fkey foreign key (source_channel, batch_id)
    references ingest.source_batch(source_channel, batch_id) on delete cascade
);

comment on table ingest.source_message is '来源无关的消息事实；主身份为渠道、会话和来源消息 ID';
comment on column ingest.source_message.source_chat_id is '平台原始会话 ID，按 text 保存避免数字代理和精度丢失';
comment on column ingest.source_message.source_message_id is '平台原始消息 ID，按 text 保存';
comment on column ingest.source_message.source_event_id is '平台事件 ID；消息重投或编辑事件可与消息身份分离';
comment on column ingest.source_message.legacy_message_id is '迁移核对用旧数字消息 ID；新代码不得用作主身份';
comment on column ingest.source_message.legacy_update_id is '迁移核对用旧 update ID；非 Telegram 来源允许为空';
comment on column ingest.source_message.payload_json is '标准化 SourceMessage 快照，不保存密钥';

create table if not exists ingest.source_asset (
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  source_asset_id text not null,
  asset_order integer not null default 0,
  kind text not null default 'image',
  mime_type text,
  width integer,
  height integer,
  size_bytes bigint,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_asset_pkey primary key (
    source_channel, source_chat_id, source_message_id, source_asset_id
  ),
  constraint source_asset_message_fkey foreign key (
    source_channel, source_chat_id, source_message_id
  ) references ingest.source_message(
    source_channel, source_chat_id, source_message_id
  ) on delete cascade,
  constraint ck_source_asset_dimensions check (
    (width is null or width > 0)
    and (height is null or height > 0)
    and (size_bytes is null or size_bytes >= 0)
  )
);

comment on table ingest.source_asset is '消息携带的图片或文档资源；资源身份不依赖 Telegram file_id 命名';
comment on column ingest.source_asset.source_asset_id is '平台原始资源稳定 ID；优先使用 file_unique_id 或 image_key';
comment on column ingest.source_asset.asset_order is '资源在消息中的零基顺序';
comment on column ingest.source_asset.kind is '资源类型，例如 image 或 document';
comment on column ingest.source_asset.payload_json is '资源来源元数据，不保存文件二进制和访问密钥';

create table if not exists ingest.recognition_run (
  recognition_id text primary key,
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  batch_id text not null,
  cache_key text,
  status text not null default 'succeeded',
  source_app text,
  data_type text not null default 'unknown',
  fields_json jsonb not null default '{}'::jsonb,
  confidence numeric(5,4),
  warnings_json jsonb not null default '[]'::jsonb,
  ocr_json jsonb,
  image_metadata_json jsonb,
  pipeline_version text not null,
  schema_name text,
  schema_version text,
  provider text,
  model text,
  prompt_version text,
  raw_result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recognition_run_message_fkey foreign key (
    source_channel, source_chat_id, source_message_id
  ) references ingest.source_message(
    source_channel, source_chat_id, source_message_id
  ) on delete cascade,
  constraint recognition_run_batch_fkey foreign key (source_channel, batch_id)
    references ingest.source_batch(source_channel, batch_id) on delete cascade,
  constraint ck_recognition_run_confidence check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  )
);

comment on table ingest.recognition_run is '通用截图识别运行结果；保存可查询元数据、证据和原始结构化输出';
comment on column ingest.recognition_run.recognition_id is '应用生成的稳定识别运行 ID 或迁移生成的 legacy ID';
comment on column ingest.recognition_run.cache_key is '包含来源资源、prompt、schema 和 model 的缓存键';
comment on column ingest.recognition_run.status is '识别状态，例如 succeeded、unmapped、failed';
comment on column ingest.recognition_run.fields_json is '来源无关的标准化字段；未知字段保留在 ingest 而不直接写 core';
comment on column ingest.recognition_run.ocr_json is 'OCR 全文、文本块、归一化坐标与置信度证据';
comment on column ingest.recognition_run.image_metadata_json is '处理前后格式、尺寸、字节数和图片操作，不含原图';
comment on column ingest.recognition_run.raw_result_json is 'AI 原始结构化结果，用于审计和重新映射';

create table if not exists ingest.pending_task (
  pending_id bigint generated by default as identity primary key,
  source_channel text not null,
  batch_id text not null,
  kind text not null default 'image',
  status text not null default 'pending',
  payload_json jsonb not null,
  failure_category text null,
  failure_reason text null,
  attempt_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  resolved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_channel, batch_id)
);

comment on table ingest.pending_task is '来源无关的失败重试任务，不依赖 Telegram 批次命名';
comment on column ingest.pending_task.source_channel is '失败任务所属来源渠道';
comment on column ingest.pending_task.payload_json is '可重放的来源无关批次快照';
create index if not exists idx_pending_task_status_retry
on ingest.pending_task(status, next_retry_at);


create index if not exists idx_source_batch_updated
  on ingest.source_batch(source_channel, updated_at desc);

create index if not exists idx_source_message_batch
  on ingest.source_message(source_channel, batch_id, updated_at desc);

create index if not exists idx_source_message_legacy_message
  on ingest.source_message(legacy_message_id)
  where legacy_message_id is not null;

create index if not exists idx_source_asset_message_order
  on ingest.source_asset(source_channel, source_chat_id, source_message_id, asset_order);

create index if not exists idx_recognition_run_cache_key
  on ingest.recognition_run(cache_key, updated_at desc)
  where cache_key is not null;

create index if not exists idx_recognition_run_source
  on ingest.recognition_run(source_channel, source_chat_id, source_message_id, updated_at desc);

create index if not exists idx_recognition_run_type_updated
  on ingest.recognition_run(data_type, updated_at desc);

-- 回填批次：优先从消息的真实 source_channel 推导；没有消息时读取批次 payload。
insert into ingest.source_batch (
  source_channel,
  batch_id,
  kind,
  status,
  archived_date,
  reason,
  confidence,
  warnings_json,
  issues_json,
  payload_hash,
  payload_json,
  processed_at,
  updated_at
)
select distinct on (source_channel, batch_id)
  source_channel,
  batch_id,
  coalesce(nullif(payload_json->>'kind', ''), 'image'),
  status,
  archived_date,
  reason,
  confidence,
  warnings_json,
  issues_json,
  payload_hash,
  payload_json,
  processed_at,
  updated_at
from (
  select
    coalesce(nullif(m.source_channel, ''), nullif(b.batch_payload_json->>'sourceChannel', ''), 'telegram') as source_channel,
    b.batch_id,
    b.status,
    b.archived_date,
    b.reason,
    b.confidence,
    b.warnings_json,
    b.issues_json,
    b.payload_hash,
    b.batch_payload_json as payload_json,
    b.processed_at,
    b.updated_at
  from ingest.telegram_batch b
  left join ingest.telegram_message m on m.batch_id = b.batch_id
) legacy_batch
order by source_channel, batch_id, updated_at desc
on conflict (source_channel, batch_id) do update set
  kind = excluded.kind,
  status = excluded.status,
  archived_date = excluded.archived_date,
  reason = excluded.reason,
  confidence = excluded.confidence,
  warnings_json = excluded.warnings_json,
  issues_json = excluded.issues_json,
  payload_hash = excluded.payload_hash,
  payload_json = excluded.payload_json,
  processed_at = excluded.processed_at,
  updated_at = excluded.updated_at;

-- 回填消息：平台原始字符串 ID 成为主身份，旧数字 ID 仅用于迁移核对。
insert into ingest.source_message (
  source_channel,
  source_chat_id,
  source_message_id,
  batch_id,
  source_event_id,
  legacy_message_id,
  legacy_update_id,
  media_group_id,
  sent_at,
  caption,
  message_text,
  payload_json,
  updated_at
)
select
  m.source_channel,
  m.source_chat_id,
  m.source_message_id,
  m.batch_id,
  null,
  m.message_id,
  m.update_id,
  m.media_group_id,
  case when m.date_unix > 0 then to_timestamp(m.date_unix) else null end,
  coalesce(m.caption, ''),
  coalesce(m.text, ''),
  jsonb_build_object(
    'photoFileIds', m.photo_file_ids_json,
    'photoFileUniqueIds', m.photo_file_unique_ids_json,
    'legacyChatId', m.chat_id
  ),
  m.updated_at
from ingest.telegram_message m
on conflict (source_channel, source_chat_id, source_message_id) do update set
  batch_id = excluded.batch_id,
  legacy_message_id = excluded.legacy_message_id,
  legacy_update_id = excluded.legacy_update_id,
  media_group_id = excluded.media_group_id,
  sent_at = excluded.sent_at,
  caption = excluded.caption,
  message_text = excluded.message_text,
  payload_json = excluded.payload_json,
  updated_at = excluded.updated_at;

-- 回填资源：按 JSON 数组顺序配对 file_id 与 file_unique_id。
insert into ingest.source_asset (
  source_channel,
  source_chat_id,
  source_message_id,
  source_asset_id,
  asset_order,
  kind,
  payload_json,
  created_at,
  updated_at
)
select
  m.source_channel,
  m.source_chat_id,
  m.source_message_id,
  coalesce(nullif(u.file_unique_id, ''), nullif(f.file_id, ''), f.ordinality::text),
  (f.ordinality - 1)::integer,
  'image',
  jsonb_build_object(
    'legacyFileId', f.file_id,
    'legacyFileUniqueId', u.file_unique_id
  ),
  m.updated_at,
  m.updated_at
from ingest.telegram_message m
cross join lateral jsonb_array_elements_text(m.photo_file_ids_json) with ordinality
  as f(file_id, ordinality)
left join lateral jsonb_array_elements_text(m.photo_file_unique_ids_json) with ordinality
  as u(file_unique_id, ordinality) on u.ordinality = f.ordinality
on conflict (source_channel, source_chat_id, source_message_id, source_asset_id) do update set
  asset_order = excluded.asset_order,
  kind = excluded.kind,
  payload_json = excluded.payload_json,
  updated_at = excluded.updated_at;

-- 回填识别结果：旧表每条来源消息只有一个当前结果，生成稳定 legacy recognition_id。
insert into ingest.recognition_run (
  recognition_id,
  source_channel,
  source_chat_id,
  source_message_id,
  batch_id,
  cache_key,
  status,
  source_app,
  data_type,
  fields_json,
  confidence,
  warnings_json,
  ocr_json,
  image_metadata_json,
  pipeline_version,
  schema_name,
  schema_version,
  provider,
  model,
  prompt_version,
  raw_result_json,
  created_at,
  updated_at
)
select
  concat(r.source_channel, ':', r.source_chat_id, ':', r.source_message_id, ':legacy'),
  r.source_channel,
  r.source_chat_id,
  r.source_message_id,
  r.batch_id,
  r.cache_key,
  'succeeded',
  r.source_app,
  coalesce(r.data_type, 'unknown'),
  coalesce(r.fields_json, '{}'::jsonb),
  r.confidence,
  coalesce(r.recognition_json #> '{normalizedRecognition,warnings}', r.recognition_json->'warnings', '[]'::jsonb),
  r.ocr_json,
  r.image_json,
  coalesce(r.pipeline_version, 'legacy'),
  coalesce(r.recognition_json #>> '{normalizedRecognition,runtime,schemaName}', r.recognition_json->>'schemaName'),
  coalesce(r.recognition_json #>> '{normalizedRecognition,runtime,schemaVersion}', r.recognition_json->>'schemaVersion'),
  coalesce(r.recognition_json #>> '{normalizedRecognition,runtime,provider}', r.recognition_json->>'provider'),
  coalesce(r.recognition_json #>> '{normalizedRecognition,runtime,model}', r.recognition_json->>'model'),
  coalesce(r.recognition_json #>> '{normalizedRecognition,runtime,promptVersion}', r.recognition_json->>'promptVersion'),
  r.recognition_json,
  r.updated_at,
  r.updated_at
from ingest.telegram_recognition r
on conflict (recognition_id) do update set
  batch_id = excluded.batch_id,
  cache_key = excluded.cache_key,
  status = excluded.status,
  source_app = excluded.source_app,
  data_type = excluded.data_type,
  fields_json = excluded.fields_json,
  confidence = excluded.confidence,
  warnings_json = excluded.warnings_json,
  ocr_json = excluded.ocr_json,
  image_metadata_json = excluded.image_metadata_json,
  pipeline_version = excluded.pipeline_version,
  schema_name = excluded.schema_name,
  schema_version = excluded.schema_version,
  provider = excluded.provider,
  model = excluded.model,
  prompt_version = excluded.prompt_version,
  raw_result_json = excluded.raw_result_json,
  updated_at = excluded.updated_at;

-- 回填待重试任务：从批次快照读取来源渠道，旧表保留用于回滚核对。
insert into ingest.pending_task (
  source_channel,
  batch_id,
  kind,
  status,
  payload_json,
  failure_category,
  failure_reason,
  attempt_count,
  next_retry_at,
  last_failed_at,
  resolved_at,
  created_at,
  updated_at
)
select
  coalesce(nullif(batch_payload_json->>'sourceChannel', ''), 'telegram'),
  batch_id,
  kind,
  status,
  batch_payload_json,
  failure_category,
  failure_reason,
  attempt_count,
  next_retry_at,
  last_failed_at,
  resolved_at,
  created_at,
  updated_at
from ingest.telegram_pending_batch
on conflict (source_channel, batch_id) do update set
  kind = excluded.kind,
  status = excluded.status,
  payload_json = excluded.payload_json,
  failure_category = excluded.failure_category,
  failure_reason = excluded.failure_reason,
  attempt_count = excluded.attempt_count,
  next_retry_at = excluded.next_retry_at,
  last_failed_at = excluded.last_failed_at,
  resolved_at = excluded.resolved_at,
  updated_at = excluded.updated_at;

commit;

-- 验收查询（执行后逐条确认）：
-- 1. 批次数按来源核对。
-- select source_channel, count(*) from ingest.source_batch group by source_channel order by source_channel;
-- 2. 消息数与旧表按来源核对。
-- select source_channel, count(*) from ingest.source_message group by source_channel order by source_channel;
-- select source_channel, count(*) from ingest.telegram_message group by source_channel order by source_channel;
-- 3. 识别数与缓存键回填核对。
-- select source_channel, count(*) from ingest.recognition_run group by source_channel order by source_channel;
-- select count(*) as missing_cache_key from ingest.recognition_run where cache_key is null;
-- 4. 外键孤儿必须为 0。
-- select count(*) as orphan_recognition
-- from ingest.recognition_run r
-- left join ingest.source_message m using (source_channel, source_chat_id, source_message_id)
-- where m.source_message_id is null;
-- 5. 待重试任务按来源核对。
-- select source_channel, status, count(*) from ingest.pending_task group by source_channel, status order by 1, 2;

-- 回滚说明：仅当新代码尚未部署或已回退到旧表版本时执行。
-- begin;
-- drop table if exists ingest.pending_task;
-- drop table if exists ingest.recognition_run;
-- drop table if exists ingest.source_asset;
-- drop table if exists ingest.source_message;
-- drop table if exists ingest.source_batch;
-- commit;
