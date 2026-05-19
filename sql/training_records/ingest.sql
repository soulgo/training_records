/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records
 Source Schema         : ingest

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 19/05/2026 14:41:31
*/


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
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for telegram_recognition
-- ----------------------------
DROP TABLE IF EXISTS "ingest"."telegram_recognition";
CREATE TABLE "ingest"."telegram_recognition" (
  "message_id" int8 NOT NULL,
  "batch_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "recognition_json" jsonb NOT NULL,
  "updated_at" timestamptz(6) NOT NULL
)
;

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

-- ----------------------------
-- Primary Key structure for table telegram_message
-- ----------------------------
ALTER TABLE "ingest"."telegram_message" ADD CONSTRAINT "telegram_message_pkey" PRIMARY KEY ("message_id");

-- ----------------------------
-- Primary Key structure for table telegram_recognition
-- ----------------------------
ALTER TABLE "ingest"."telegram_recognition" ADD CONSTRAINT "telegram_recognition_pkey" PRIMARY KEY ("message_id");

-- ----------------------------
-- Foreign Keys structure for table telegram_message
-- ----------------------------
ALTER TABLE "ingest"."telegram_message" ADD CONSTRAINT "telegram_message_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingest"."telegram_batch" ("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table telegram_recognition
-- ----------------------------
ALTER TABLE "ingest"."telegram_recognition" ADD CONSTRAINT "telegram_recognition_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingest"."telegram_batch" ("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ingest"."telegram_recognition" ADD CONSTRAINT "telegram_recognition_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ingest"."telegram_message" ("message_id") ON DELETE CASCADE ON UPDATE NO ACTION;
