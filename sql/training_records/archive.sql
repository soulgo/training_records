/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records
 Source Schema         : archive

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 19/05/2026 14:40:57
*/


-- ----------------------------
-- Table structure for training_activity
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_activity";
CREATE TABLE "archive"."training_activity" (
  "activity_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
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
COMMENT ON TABLE "archive"."training_activity" IS '训练活动明细表，一次活动一行';

-- ----------------------------
-- Table structure for training_day
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_day";
CREATE TABLE "archive"."training_day" (
  "archived_date" date NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "total_activities" int4 NOT NULL DEFAULT 0,
  "total_duration_seconds" int4 NOT NULL DEFAULT 0,
  "training_calories" int4,
  "workout_duration_minutes" int4,
  "active_hours" int4,
  "cycling_distance_km" numeric(10,2),
  "intake_calories" int4,
  "measurement_count" int4 NOT NULL DEFAULT 0,
  "meal_count" int4 NOT NULL DEFAULT 0,
  "updated_at" timestamptz(6) NOT NULL
)
;
COMMENT ON TABLE "archive"."training_day" IS '训练归档日汇总表，一天一行，供主查询和看板使用';

-- ----------------------------
-- Table structure for training_meal
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_meal";
CREATE TABLE "archive"."training_meal" (
  "meal_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "meal_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "calories" int4,
  "recommended_min" int4,
  "recommended_max" int4,
  "updated_at" timestamptz(6) NOT NULL
)
;
COMMENT ON TABLE "archive"."training_meal" IS '训练饮食明细表，一餐一行';

-- ----------------------------
-- Table structure for training_measurement
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_measurement";
CREATE TABLE "archive"."training_measurement" (
  "measurement_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "measured_at" text COLLATE "pg_catalog"."default",
  "weight_kg" numeric(10,3),
  "bmi" numeric(10,2),
  "body_fat_pct" numeric(10,2),
  "skeletal_muscle_kg" numeric(10,3),
  "body_water_pct" numeric(10,2),
  "protein_pct" numeric(10,2),
  "bone_mass_kg" numeric(10,3),
  "visceral_fat_level" numeric(10,2),
  "basal_metabolism_kcal" int4,
  "body_age" int4,
  "body_score" int4,
  "body_type" text COLLATE "pg_catalog"."default",
  "fat_free_mass_kg" numeric(10,3),
  "updated_at" timestamptz(6) NOT NULL
)
;
COMMENT ON TABLE "archive"."training_measurement" IS '训练体测明细表，一次体测一行';

-- ----------------------------
-- Table structure for training_parse_run
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_parse_run";
CREATE TABLE "archive"."training_parse_run" (
  "run_id" uuid NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "trigger_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "actor_name" text COLLATE "pg_catalog"."default",
  "runtime_env" text COLLATE "pg_catalog"."default" NOT NULL,
  "run_started_at" timestamptz(6) NOT NULL,
  "run_finished_at" timestamptz(6) NOT NULL,
  "daily_count" int4 NOT NULL,
  "latest_archived_date" date,
  "main_output_written" bool NOT NULL DEFAULT true,
  "db_sync_status" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'success'::text
)
;
COMMENT ON COLUMN "archive"."training_parse_run"."run_id" IS '本次运行唯一标识UUID';
COMMENT ON COLUMN "archive"."training_parse_run"."source_hash" IS '关联的训练记录原文哈希，对应快照表主键';
COMMENT ON COLUMN "archive"."training_parse_run"."trigger_name" IS '触发来源，例如local-build-data、local-build、github-actions-build';
COMMENT ON COLUMN "archive"."training_parse_run"."actor_name" IS '触发执行人，本地为系统用户名，CI为GitHub Actor';
COMMENT ON COLUMN "archive"."training_parse_run"."runtime_env" IS '运行环境标识，例如local或github-actions';
COMMENT ON COLUMN "archive"."training_parse_run"."run_started_at" IS '本次构建开始时间';
COMMENT ON COLUMN "archive"."training_parse_run"."run_finished_at" IS '本次构建结束时间';
COMMENT ON COLUMN "archive"."training_parse_run"."daily_count" IS '本次运行解析出的日期记录总数';
COMMENT ON COLUMN "archive"."training_parse_run"."latest_archived_date" IS '本次运行解析结果中最新的归档日期';
COMMENT ON COLUMN "archive"."training_parse_run"."main_output_written" IS '主输出文件training.json和调试Markdown是否已成功写出';
COMMENT ON COLUMN "archive"."training_parse_run"."db_sync_status" IS '数据库归档状态，当前成功写入固定为success，预留后续扩展';
COMMENT ON TABLE "archive"."training_parse_run" IS '训练记录解析运行留痕表，每次执行构建都会新增一条记录';

-- ----------------------------
-- Table structure for training_parse_snapshot
-- ----------------------------
DROP TABLE IF EXISTS "archive"."training_parse_snapshot";
CREATE TABLE "archive"."training_parse_snapshot" (
  "source_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "payload_version" int4 NOT NULL DEFAULT 1,
  "payload_json" jsonb NOT NULL,
  "daily_count" int4 NOT NULL,
  "latest_archived_date" date,
  "parsed_generated_at" timestamptz(6) NOT NULL,
  "first_seen_at" timestamptz(6) NOT NULL,
  "last_seen_at" timestamptz(6) NOT NULL
)
;
COMMENT ON COLUMN "archive"."training_parse_snapshot"."source_hash" IS '训练记录Markdown原文的SHA-256哈希，作为快照主键';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."payload_version" IS '解析结果结构版本号，便于后续结构升级兼容';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."payload_json" IS '完整解析结果JSON，内容对应当前parseTrainingRecord输出';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."daily_count" IS '本次解析出的日期记录总数';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."latest_archived_date" IS '本次解析结果中最新的归档日期';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."parsed_generated_at" IS '解析结果中的generatedAt时间';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."first_seen_at" IS '该快照首次入库时间';
COMMENT ON COLUMN "archive"."training_parse_snapshot"."last_seen_at" IS '该快照最近一次被再次观察到的时间';
COMMENT ON TABLE "archive"."training_parse_snapshot" IS '训练记录解析快照表，按训练记录原文哈希去重保存完整解析结果';

-- ----------------------------
-- Indexes structure for table training_activity
-- ----------------------------
CREATE INDEX "idx_training_activity_archived_date" ON "archive"."training_activity" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);
CREATE INDEX "idx_training_activity_type_date" ON "archive"."training_activity" USING btree (
  "activity_type" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "archived_date" "pg_catalog"."date_ops" DESC NULLS FIRST
);

-- ----------------------------
-- Primary Key structure for table training_activity
-- ----------------------------
ALTER TABLE "archive"."training_activity" ADD CONSTRAINT "training_activity_pkey" PRIMARY KEY ("activity_hash");

-- ----------------------------
-- Indexes structure for table training_day
-- ----------------------------
CREATE INDEX "idx_training_day_source_hash" ON "archive"."training_day" USING btree (
  "source_hash" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table training_day
-- ----------------------------
ALTER TABLE "archive"."training_day" ADD CONSTRAINT "training_day_pkey" PRIMARY KEY ("archived_date");

-- ----------------------------
-- Indexes structure for table training_meal
-- ----------------------------
CREATE INDEX "idx_training_meal_archived_date" ON "archive"."training_meal" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table training_meal
-- ----------------------------
ALTER TABLE "archive"."training_meal" ADD CONSTRAINT "training_meal_pkey" PRIMARY KEY ("meal_hash");

-- ----------------------------
-- Indexes structure for table training_measurement
-- ----------------------------
CREATE INDEX "idx_training_measurement_archived_date" ON "archive"."training_measurement" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table training_measurement
-- ----------------------------
ALTER TABLE "archive"."training_measurement" ADD CONSTRAINT "training_measurement_pkey" PRIMARY KEY ("measurement_hash");

-- ----------------------------
-- Indexes structure for table training_parse_run
-- ----------------------------
CREATE INDEX "idx_training_parse_run_finished_at" ON "archive"."training_parse_run" USING btree (
  "run_finished_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
COMMENT ON INDEX "archive"."idx_training_parse_run_finished_at" IS '按运行结束时间倒序查询运行历史的索引';
CREATE INDEX "idx_training_parse_run_source_hash" ON "archive"."training_parse_run" USING btree (
  "source_hash" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
COMMENT ON INDEX "archive"."idx_training_parse_run_source_hash" IS '按快照哈希查询对应运行记录的索引';
CREATE INDEX "idx_training_parse_run_trigger_finished_at" ON "archive"."training_parse_run" USING btree (
  "trigger_name" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "run_finished_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
COMMENT ON INDEX "archive"."idx_training_parse_run_trigger_finished_at" IS '按触发来源和运行结束时间查询历史记录的索引';

-- ----------------------------
-- Primary Key structure for table training_parse_run
-- ----------------------------
ALTER TABLE "archive"."training_parse_run" ADD CONSTRAINT "training_parse_run_pkey" PRIMARY KEY ("run_id");

-- ----------------------------
-- Primary Key structure for table training_parse_snapshot
-- ----------------------------
ALTER TABLE "archive"."training_parse_snapshot" ADD CONSTRAINT "training_parse_snapshot_pkey" PRIMARY KEY ("source_hash");

-- ----------------------------
-- Foreign Keys structure for table training_activity
-- ----------------------------
ALTER TABLE "archive"."training_activity" ADD CONSTRAINT "training_activity_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "archive"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "archive"."training_activity" ADD CONSTRAINT "training_activity_source_hash_fkey" FOREIGN KEY ("source_hash") REFERENCES "archive"."training_parse_snapshot" ("source_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table training_day
-- ----------------------------
ALTER TABLE "archive"."training_day" ADD CONSTRAINT "training_day_source_hash_fkey" FOREIGN KEY ("source_hash") REFERENCES "archive"."training_parse_snapshot" ("source_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table training_meal
-- ----------------------------
ALTER TABLE "archive"."training_meal" ADD CONSTRAINT "training_meal_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "archive"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "archive"."training_meal" ADD CONSTRAINT "training_meal_source_hash_fkey" FOREIGN KEY ("source_hash") REFERENCES "archive"."training_parse_snapshot" ("source_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table training_measurement
-- ----------------------------
ALTER TABLE "archive"."training_measurement" ADD CONSTRAINT "training_measurement_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "archive"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "archive"."training_measurement" ADD CONSTRAINT "training_measurement_source_hash_fkey" FOREIGN KEY ("source_hash") REFERENCES "archive"."training_parse_snapshot" ("source_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table training_parse_run
-- ----------------------------
ALTER TABLE "archive"."training_parse_run" ADD CONSTRAINT "training_parse_run_source_hash_fkey" FOREIGN KEY ("source_hash") REFERENCES "archive"."training_parse_snapshot" ("source_hash") ON DELETE NO ACTION ON UPDATE NO ACTION;
