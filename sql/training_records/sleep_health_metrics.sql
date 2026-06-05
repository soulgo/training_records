-- ----------------------------
-- Sleep health metrics incremental update
-- ----------------------------
-- 用途：给 core.sleep 和 archive.training_sleep 补齐华为睡眠截图第三个红框中的健康指标字段。
-- 说明：本脚本是增量式 SQL，不会删除已有表或已有数据。
-- 执行时机：部署包含睡眠健康指标写入代码之前先执行。

CREATE SCHEMA IF NOT EXISTS "core";
CREATE SCHEMA IF NOT EXISTS "archive";

CREATE TABLE IF NOT EXISTS "core"."sleep" (
  "sleep_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "source_batch_id" text COLLATE "pg_catalog"."default",
  "sleep_type" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT '夜间睡眠'::text,
  "bedtime" text COLLATE "pg_catalog"."default",
  "wake_time" text COLLATE "pg_catalog"."default",
  "night_sleep_minutes" int4,
  "total_sleep_minutes" int4,
  "nap_minutes" int4,
  "deep_sleep_minutes" int4,
  "light_sleep_minutes" int4,
  "rem_sleep_minutes" int4,
  "awake_minutes" int4,
  "sleep_stage_text" text COLLATE "pg_catalog"."default",
  "sleep_stage_detail" text COLLATE "pg_catalog"."default",
  "updated_at" timestamptz(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS "archive"."training_sleep" (
  "sleep_hash" text COLLATE "pg_catalog"."default" NOT NULL,
  "archived_date" date NOT NULL,
  "source_hash" text COLLATE "pg_catalog"."default",
  "sleep_type" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT '夜间睡眠'::text,
  "bedtime" text COLLATE "pg_catalog"."default",
  "wake_time" text COLLATE "pg_catalog"."default",
  "night_sleep_minutes" int4,
  "total_sleep_minutes" int4,
  "nap_minutes" int4,
  "deep_sleep_minutes" int4,
  "light_sleep_minutes" int4,
  "rem_sleep_minutes" int4,
  "awake_minutes" int4,
  "sleep_stage_text" text COLLATE "pg_catalog"."default",
  "sleep_stage_detail" text COLLATE "pg_catalog"."default",
  "updated_at" timestamptz(6) NOT NULL
);

ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_score" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_score_percentile" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "deep_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "light_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "rem_sleep_ratio_pct" numeric(10,2);
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "deep_sleep_continuity_score" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "wake_count" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "breathing_quality_score" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "average_heart_rate_bpm" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "hrv_ms" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "average_spo2_pct" numeric(10,2);
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "average_respiratory_rate" numeric(10,2);
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "analysis_text" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "suggestion_text" text COLLATE "pg_catalog"."default";

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint"
    WHERE "conname" = 'sleep_pkey'
      AND "conrelid" = '"core"."sleep"'::regclass
  ) THEN
    ALTER TABLE "core"."sleep" ADD CONSTRAINT "sleep_pkey" PRIMARY KEY ("sleep_key");
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint"
    WHERE "conname" = 'training_sleep_pkey'
      AND "conrelid" = '"archive"."training_sleep"'::regclass
  ) THEN
    ALTER TABLE "archive"."training_sleep" ADD CONSTRAINT "training_sleep_pkey" PRIMARY KEY ("sleep_hash");
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idx_core_sleep_archived_date" ON "core"."sleep" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

CREATE INDEX IF NOT EXISTS "idx_archive_training_sleep_archived_date" ON "archive"."training_sleep" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

COMMENT ON COLUMN "core"."sleep"."sleep_score" IS '睡眠评分，例如华为睡眠卡片中的 81 分';
COMMENT ON COLUMN "core"."sleep"."sleep_score_percentile" IS '超过用户百分比，只保存数字部分';
COMMENT ON COLUMN "core"."sleep"."deep_sleep_ratio_pct" IS '深睡比例百分比，只保存数字部分';
COMMENT ON COLUMN "core"."sleep"."light_sleep_ratio_pct" IS '浅睡比例百分比，只保存数字部分';
COMMENT ON COLUMN "core"."sleep"."rem_sleep_ratio_pct" IS '快速眼动 REM 比例百分比，只保存数字部分';
COMMENT ON COLUMN "core"."sleep"."deep_sleep_continuity_score" IS '深睡连续性评分';
COMMENT ON COLUMN "core"."sleep"."wake_count" IS '清醒次数';
COMMENT ON COLUMN "core"."sleep"."breathing_quality_score" IS '呼吸质量评分';
COMMENT ON COLUMN "core"."sleep"."average_heart_rate_bpm" IS '平均心率，单位次/分钟';
COMMENT ON COLUMN "core"."sleep"."hrv_ms" IS '平均心率变异性 HRV，单位毫秒';
COMMENT ON COLUMN "core"."sleep"."average_spo2_pct" IS '平均血氧饱和度百分比';
COMMENT ON COLUMN "core"."sleep"."average_respiratory_rate" IS '平均呼吸率，单位次/分钟';
COMMENT ON COLUMN "core"."sleep"."analysis_text" IS '截图底部睡眠解读文本';
COMMENT ON COLUMN "core"."sleep"."suggestion_text" IS '截图底部睡眠建议文本';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_roles"
    WHERE "rolname" = 'training_writer'
  ) THEN
    GRANT USAGE ON SCHEMA "archive" TO "training_writer";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "archive"."training_sleep" TO "training_writer";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."sleep" TO "training_writer";
  END IF;
END
$$;
