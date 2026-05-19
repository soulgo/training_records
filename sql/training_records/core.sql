/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records
 Source Schema         : core

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 19/05/2026 14:41:22
*/


-- ----------------------------
-- Table structure for activity
-- ----------------------------
DROP TABLE IF EXISTS "core"."activity";
CREATE TABLE "core"."activity" (
  "activity_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "activity_time" text COLLATE "pg_catalog"."default",
  "activity_type" text COLLATE "pg_catalog"."default" NOT NULL,
  "raw_type" text COLLATE "pg_catalog"."default",
  "detail" text COLLATE "pg_catalog"."default",
  "calories" int4,
  "heart_rate" int4,
  "distance_km" numeric(10,2),
  "avg_speed_kmh" numeric(10,2),
  "duration_text" text COLLATE "pg_catalog"."default",
  "duration_seconds" int4,
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for meal
-- ----------------------------
DROP TABLE IF EXISTS "core"."meal";
CREATE TABLE "core"."meal" (
  "meal_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "meal_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "calories" int4,
  "recommended_min" int4,
  "recommended_max" int4,
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for thought
-- ----------------------------
DROP TABLE IF EXISTS "core"."thought";
CREATE TABLE "core"."thought" (
  "telegram_message_id" int8 NOT NULL,
  "telegram_chat_id" int8,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "command" text COLLATE "pg_catalog"."default" NOT NULL,
  "body" text COLLATE "pg_catalog"."default" NOT NULL,
  "tags_json" jsonb NOT NULL DEFAULT '["训练","随想","Telegram"]'::jsonb,
  "message_date_unix" int8,
  "markdown_path" text COLLATE "pg_catalog"."default",
  "image_refs_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'active'::text,
  "deleted_at" timestamptz(6),
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for measurement
-- ----------------------------
DROP TABLE IF EXISTS "core"."measurement";
CREATE TABLE "core"."measurement" (
  "measurement_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "measured_at" text COLLATE "pg_catalog"."default",
  "body_score" int4,
  "weight_kg" numeric(10,3),
  "bmi" numeric(10,2),
  "body_fat_pct" numeric(10,2),
  "skeletal_muscle_kg" numeric(10,3),
  "visceral_fat_level" numeric(10,2),
  "basal_metabolism_kcal" int4,
  "body_water_pct" numeric(10,2),
  "protein_pct" numeric(10,2),
  "bone_mass_kg" numeric(10,3),
  "fat_free_mass_kg" numeric(10,3),
  "body_age" int4,
  "body_type" text COLLATE "pg_catalog"."default",
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Table structure for training_day
-- ----------------------------
DROP TABLE IF EXISTS "core"."training_day";
CREATE TABLE "core"."training_day" (
  "archived_date" date NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "total_activities" int4 NOT NULL DEFAULT 0,
  "total_duration_seconds" int4 NOT NULL DEFAULT 0,
  "training_calories" numeric(10,2) NOT NULL DEFAULT 0,
  "workout_duration_minutes" int4,
  "active_hours" int4,
  "cycling_distance_km" numeric(10,2),
  "intake_calories" int4,
  "nutrition_details_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz(6) NOT NULL
)
;

-- ----------------------------
-- Indexes structure for table activity
-- ----------------------------
CREATE INDEX "idx_core_activity_archived_date" ON "core"."activity" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table activity
-- ----------------------------
ALTER TABLE "core"."activity" ADD CONSTRAINT "activity_pkey" PRIMARY KEY ("activity_key");

-- ----------------------------
-- Indexes structure for table meal
-- ----------------------------
CREATE INDEX "idx_core_meal_archived_date" ON "core"."meal" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Indexes structure for table thought
-- ----------------------------
CREATE INDEX "idx_core_thought_updated_at" ON "core"."thought" USING btree (
  "updated_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);

-- ----------------------------
-- Primary Key structure for table meal
-- ----------------------------
ALTER TABLE "core"."meal" ADD CONSTRAINT "meal_pkey" PRIMARY KEY ("meal_key");

-- ----------------------------
-- Primary Key structure for table thought
-- ----------------------------
ALTER TABLE "core"."thought" ADD CONSTRAINT "thought_pkey" PRIMARY KEY ("telegram_message_id");

-- ----------------------------
-- Indexes structure for table measurement
-- ----------------------------
CREATE INDEX "idx_core_measurement_archived_date" ON "core"."measurement" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table measurement
-- ----------------------------
ALTER TABLE "core"."measurement" ADD CONSTRAINT "measurement_pkey" PRIMARY KEY ("measurement_key");

-- ----------------------------
-- Primary Key structure for table training_day
-- ----------------------------
ALTER TABLE "core"."training_day" ADD CONSTRAINT "training_day_pkey" PRIMARY KEY ("archived_date");

-- ----------------------------
-- Foreign Keys structure for table activity
-- ----------------------------
ALTER TABLE "core"."activity" ADD CONSTRAINT "activity_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "core"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table meal
-- ----------------------------
ALTER TABLE "core"."meal" ADD CONSTRAINT "meal_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "core"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table measurement
-- ----------------------------
ALTER TABLE "core"."measurement" ADD CONSTRAINT "measurement_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "core"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;
