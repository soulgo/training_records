/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records_dev
 Source Schema         : archive

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

Date: 04/06/2026 16:12:23
*/

-- ----------------------------
-- Incremental sleep health metric columns
-- ----------------------------
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "sleep_score" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "sleep_score_percentile" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "deep_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "light_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "rem_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "deep_sleep_continuity_score" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "wake_count" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "breathing_quality_score" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "average_heart_rate_bpm" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "hrv_ms" int4;
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "average_spo2_pct" numeric(10,2);
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "average_respiratory_rate" numeric(10,2);
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "analysis_text" text COLLATE "pg_catalog"."default";
ALTER TABLE "archive"."training_sleep" ADD COLUMN IF NOT EXISTS "suggestion_text" text COLLATE "pg_catalog"."default";
