/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records_dev
 Source Schema         : ingest

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 04/06/2026 16:13:02
*/


-- ----------------------------
-- Sequence structure for telegram_pending_batch_pending_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "ingest"."telegram_pending_batch_pending_id_seq";
CREATE SEQUENCE "ingest"."telegram_pending_batch_pending_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 9223372036854775807
START 1
CACHE 1;

-- ----------------------------
-- Table structure for telegram_batch
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."telegram_batch";
CREATE TABLE "ingest"."telegram_batch" (
  "batch_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date,
  "reason" text COLLATE "pg_catalog"."default",
  "confidence" numeric(10,4),
  "warnings_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "issues_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "update_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "batch_payload_json" jsonb NOT NULL,
  "processed_at" timestamptz(6) NOT NULL,
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for telegram_message
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."telegram_message";
CREATE TABLE "ingest"."telegram_message" (
  "message_id" int8 NOT NULL,
  "batch_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "update_id" int8 NOT NULL,
  "media_group_id" text COLLATE "pg_catalog"."default",
  "chat_id" int8,
  "caption" text COLLATE "pg_catalog"."default",
  "text" text COLLATE "pg_catalog"."default",
  "date_unix" int8,
  "photo_file_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "photo_file_unique_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'telegram'::text,
  "source_chat_id" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'legacy-chat'::text,
  "source_message_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for telegram_pending_batch
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."telegram_pending_batch";
CREATE TABLE "ingest"."telegram_pending_batch" (
  "pending_id" int8 NOT NULL DEFAULT nextval('"ingest".telegram_pending_batch_pending_id_seq'::regclass),
  "batch_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "kind" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'image'::text,
  "status" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'pending'::text,
  "batch_payload_json" jsonb NOT NULL,
  "failure_category" text COLLATE "pg_catalog"."default",
  "failure_reason" text COLLATE "pg_catalog"."default",
  "attempt_count" int4 NOT NULL DEFAULT 0,
  "next_retry_at" timestamptz(6) NOT NULL DEFAULT now(),
  "last_failed_at" timestamptz(6) NOT NULL DEFAULT now(),
  "resolved_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."pending_id" IS '待重试记录自增主键';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."batch_id" IS 'Telegram 批次 ID，单图为 single-messageId，相册为 media_group_id';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."kind" IS '批次类型，当前主要为 image';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."status" IS '重试状态：pending 待重试，resolved 已成功处理，abandoned 放弃处理';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."batch_payload_json" IS '完整批次 payload，包含 messageId、updateId、chatId、photo file_id 等重放所需数据';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."failure_category" IS '最近一次失败分类，例如 ai_service、telegram_api、system_bug';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."failure_reason" IS '最近一次失败原因摘要';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."attempt_count" IS '已重试次数';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."next_retry_at" IS '下次允许重试时间';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."last_failed_at" IS '最近一次失败时间';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."resolved_at" IS '成功处理或人工关闭时间';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."created_at" IS '记录创建时间';
COMMENT ON COLUMN "ingest"."telegram_pending_batch"."updated_at" IS '记录更新时间';
COMMENT ON TABLE "ingest"."telegram_pending_batch" IS 'Telegram 同步待重试批次表，用于保存 AI 识别失败但不能丢弃的图片批次';

-- ----------------------------
-- Table structure for telegram_recognition
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."telegram_recognition";
CREATE TABLE "ingest"."telegram_recognition" (
  "message_id" int8 NOT NULL,
  "batch_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "recognition_json" jsonb NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'telegram'::text,
  "source_chat_id" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'legacy-chat'::text,
  "source_message_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_app" text COLLATE "pg_catalog"."default",
  "data_type" text COLLATE "pg_catalog"."default",
  "fields_json" jsonb,
  "confidence" numeric(5,4),
  "pipeline_version" text COLLATE "pg_catalog"."default",
  "ocr_json" jsonb,
  "image_json" jsonb,
  "cache_key" text COLLATE "pg_catalog"."default",
  "updated_at" timestamptz(6) NOT NULL
)
;
COMMENT ON COLUMN "ingest"."telegram_recognition"."source_app" IS '识别出的来源应用';
COMMENT ON COLUMN "ingest"."telegram_recognition"."data_type" IS '标准化数据类型';
COMMENT ON COLUMN "ingest"."telegram_recognition"."fields_json" IS '跨来源标准化业务字段';
COMMENT ON COLUMN "ingest"."telegram_recognition"."confidence" IS '识别置信度，范围 0 到 1';
COMMENT ON COLUMN "ingest"."telegram_recognition"."pipeline_version" IS '识别管线版本';
COMMENT ON COLUMN "ingest"."telegram_recognition"."ocr_json" IS 'OCR 文本与坐标证据';
COMMENT ON COLUMN "ingest"."telegram_recognition"."image_json" IS '图片处理与质量元数据';
COMMENT ON COLUMN "ingest"."telegram_recognition"."cache_key" IS '来源范围内的精确识别缓存键';

-- ----------------------------
-- Table structure for ai_call_log
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."ai_call_log";
CREATE TABLE "ingest"."ai_call_log" (
  "ai_call_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "task_id" text COLLATE "pg_catalog"."default",
  "scene" text COLLATE "pg_catalog"."default" NOT NULL,
  "provider" text COLLATE "pg_catalog"."default" NOT NULL,
  "model" text COLLATE "pg_catalog"."default" NOT NULL,
  "prompt_version" text COLLATE "pg_catalog"."default",
  "idempotency_key" text COLLATE "pg_catalog"."default",
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "latency_ms" int4,
  "failure_category" text COLLATE "pg_catalog"."default",
  "failure_reason" text COLLATE "pg_catalog"."default",
  "prompt_tokens" int4,
  "completion_tokens" int4,
  "total_tokens" int4,
  "cost_usd" numeric(12,6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
SELECT setval('"ingest"."telegram_pending_batch_pending_id_seq"', 2, true);

-- ----------------------------
-- Primary Key structure for table telegram_batch
-- ----------------------------
ALTER TABLE "ingest"."telegram_batch" ADD CONSTRAINT "telegram_batch_pkey" PRIMARY KEY ("batch_id");

-- ----------------------------
-- Indexes structure for table telegram_message
-- ----------------------------
CREATE INDEX "idx_ingest_telegram_message_update_id" ON "ingest"."telegram_message" USING btree (
  "update_id" "pg_catalog"."int8_ops" DESC NULLS FIRST
);
CREATE INDEX "idx_ingest_telegram_message_legacy_message_id" ON "ingest"."telegram_message" USING btree (
  "message_id" "pg_catalog"."int8_ops" ASC NULLS LAST
);
CREATE UNIQUE INDEX "ux_ingest_telegram_message_source_identity" ON "ingest"."telegram_message" USING btree (
  "source_channel" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_chat_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_message_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table telegram_message
-- ----------------------------
ALTER TABLE "ingest"."telegram_message" ADD CONSTRAINT "telegram_message_pkey" PRIMARY KEY ("source_channel", "source_chat_id", "source_message_id");

-- ----------------------------
-- Indexes structure for table telegram_pending_batch
-- ----------------------------
CREATE INDEX "idx_ingest_telegram_pending_batch_status_retry" ON "ingest"."telegram_pending_batch" USING btree (
  "status" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "next_retry_at" "pg_catalog"."timestamptz_ops" ASC NULLS LAST
);
CREATE INDEX "idx_ingest_telegram_pending_batch_updated_at" ON "ingest"."telegram_pending_batch" USING btree (
  "updated_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);

-- ----------------------------
-- Uniques structure for table telegram_pending_batch
-- ----------------------------
ALTER TABLE "ingest"."telegram_pending_batch" ADD CONSTRAINT "telegram_pending_batch_batch_id_key" UNIQUE ("batch_id");

-- ----------------------------
-- Primary Key structure for table telegram_pending_batch
-- ----------------------------
ALTER TABLE "ingest"."telegram_pending_batch" ADD CONSTRAINT "telegram_pending_batch_pkey" PRIMARY KEY ("pending_id");

-- ----------------------------
-- Primary Key structure for table telegram_recognition
-- ----------------------------
CREATE INDEX "idx_ingest_telegram_recognition_legacy_message_id" ON "ingest"."telegram_recognition" USING btree (
  "message_id" "pg_catalog"."int8_ops" ASC NULLS LAST
);
CREATE INDEX "idx_ingest_telegram_recognition_cache_key" ON "ingest"."telegram_recognition" USING btree (
  "cache_key" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
) WHERE "cache_key" IS NOT NULL;
CREATE INDEX "idx_ingest_telegram_recognition_type_updated" ON "ingest"."telegram_recognition" USING btree (
  "data_type" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "updated_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE UNIQUE INDEX "ux_ingest_telegram_recognition_source_identity" ON "ingest"."telegram_recognition" USING btree (
  "source_channel" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_chat_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_message_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
ALTER TABLE "ingest"."telegram_recognition" ADD CONSTRAINT "telegram_recognition_pkey" PRIMARY KEY ("source_channel", "source_chat_id", "source_message_id");

-- ----------------------------
-- Primary Key structure for table ai_call_log
-- ----------------------------
ALTER TABLE "ingest"."ai_call_log" ADD CONSTRAINT "ai_call_log_pkey" PRIMARY KEY ("ai_call_id");

-- ----------------------------
-- Foreign Keys structure for table telegram_message
-- ----------------------------
ALTER TABLE "ingest"."telegram_message" ADD CONSTRAINT "telegram_message_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingest"."telegram_batch" ("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table telegram_recognition
-- ----------------------------
ALTER TABLE "ingest"."telegram_recognition" ADD CONSTRAINT "telegram_recognition_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingest"."telegram_batch" ("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Generic ingest tables (Phase 2)
-- ----------------------------
create table if not exists ingest.source_batch (
  source_channel text not null,
  batch_id text not null,
  kind text not null default 'image',
  status text not null,
  archived_date date null,
  reason text null,
  confidence numeric(5,4) null check (confidence is null or (confidence >= 0 and confidence <= 1)),
  warnings_json jsonb not null default '[]'::jsonb,
  issues_json jsonb not null default '[]'::jsonb,
  payload_hash text not null,
  payload_json jsonb not null,
  processed_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (source_channel, batch_id)
);

create table if not exists ingest.source_message (
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  batch_id text not null,
  source_event_id text null,
  legacy_message_id bigint null,
  legacy_update_id bigint null,
  media_group_id text null,
  sent_at timestamptz null,
  caption text not null default '',
  message_text text not null default '',
  payload_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null,
  primary key (source_channel, source_chat_id, source_message_id),
  foreign key (source_channel, batch_id)
    references ingest.source_batch(source_channel, batch_id) on delete cascade
);

create table if not exists ingest.source_asset (
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  source_asset_id text not null,
  asset_order integer not null default 0,
  kind text not null default 'image',
  mime_type text null,
  width integer null,
  height integer null,
  size_bytes bigint null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_channel, source_chat_id, source_message_id, source_asset_id),
  foreign key (source_channel, source_chat_id, source_message_id)
    references ingest.source_message(source_channel, source_chat_id, source_message_id) on delete cascade
);

create table if not exists ingest.recognition_run (
  recognition_id text primary key,
  source_channel text not null,
  source_chat_id text not null,
  source_message_id text not null,
  batch_id text not null,
  cache_key text null,
  status text not null default 'succeeded',
  source_app text null,
  data_type text not null default 'unknown',
  fields_json jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) null check (confidence is null or (confidence >= 0 and confidence <= 1)),
  warnings_json jsonb not null default '[]'::jsonb,
  ocr_json jsonb null,
  image_metadata_json jsonb null,
  pipeline_version text not null,
  schema_name text null,
  schema_version text null,
  provider text null,
  model text null,
  prompt_version text null,
  raw_result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_channel, source_chat_id, source_message_id)
    references ingest.source_message(source_channel, source_chat_id, source_message_id) on delete cascade,
  foreign key (source_channel, batch_id)
    references ingest.source_batch(source_channel, batch_id) on delete cascade
);

comment on table ingest.source_batch is '来源无关的消息处理批次';
comment on table ingest.source_message is '来源无关的消息事实，使用平台原始字符串身份';
comment on table ingest.source_asset is '消息携带的图片或文档资源';
comment on table ingest.recognition_run is '通用 AI 截图识别运行结果';

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
create index if not exists idx_source_asset_message_order
on ingest.source_asset(source_channel, source_chat_id, source_message_id, asset_order);
create index if not exists idx_recognition_run_cache_key
on ingest.recognition_run(cache_key, updated_at desc) where cache_key is not null;
create index if not exists idx_recognition_run_source
on ingest.recognition_run(source_channel, source_chat_id, source_message_id, updated_at desc);
