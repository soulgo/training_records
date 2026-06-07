-- ----------------------------
-- Core sleep table incremental update
-- ----------------------------
-- 用途：给已有 core 数据库补齐 core.sleep 睡眠明细表。
-- 说明：本脚本是增量式 SQL，不会删除已有表或已有数据。

CREATE SCHEMA IF NOT EXISTS "core";

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

ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_key" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "archived_date" date;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "source_channel" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "source_batch_id" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_type" text COLLATE "pg_catalog"."default" DEFAULT '夜间睡眠'::text;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "bedtime" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "wake_time" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "night_sleep_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "total_sleep_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "nap_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "deep_sleep_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "light_sleep_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "rem_sleep_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "awake_minutes" int4;
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_stage_text" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "sleep_stage_detail" text COLLATE "pg_catalog"."default";
ALTER TABLE "core"."sleep" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz(6);

ALTER TABLE "core"."sleep" ALTER COLUMN "sleep_key" SET NOT NULL;
ALTER TABLE "core"."sleep" ALTER COLUMN "archived_date" SET NOT NULL;
ALTER TABLE "core"."sleep" ALTER COLUMN "source_channel" SET NOT NULL;
ALTER TABLE "core"."sleep" ALTER COLUMN "sleep_type" SET DEFAULT '夜间睡眠'::text;
ALTER TABLE "core"."sleep" ALTER COLUMN "sleep_type" SET NOT NULL;
ALTER TABLE "core"."sleep" ALTER COLUMN "updated_at" SET NOT NULL;

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
END
$$;

CREATE INDEX IF NOT EXISTS "idx_core_sleep_archived_date" ON "core"."sleep" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

DO $$
BEGIN
  IF to_regclass('"core"."training_day"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "pg_catalog"."pg_constraint"
      WHERE "conname" = 'sleep_archived_date_fkey'
        AND "conrelid" = '"core"."sleep"'::regclass
    )
  THEN
    ALTER TABLE "core"."sleep"
      ADD CONSTRAINT "sleep_archived_date_fkey"
      FOREIGN KEY ("archived_date")
      REFERENCES "core"."training_day" ("archived_date")
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;
END
$$;

COMMENT ON TABLE "core"."sleep" IS '核心训练睡眠明细表，Telegram 或 Markdown 解析后的每条睡眠记录一行';
COMMENT ON COLUMN "core"."sleep"."sleep_key" IS '睡眠记录幂等键，按归档日期、睡眠类型、入睡时间、醒来时间和总睡眠分钟数生成';
COMMENT ON COLUMN "core"."sleep"."archived_date" IS '归档日期，关联 core.training_day.archived_date';
COMMENT ON COLUMN "core"."sleep"."source_channel" IS '来源通道，例如 telegram、markdown_import、archive_backfill 或 ingest_sleep_backfill';
COMMENT ON COLUMN "core"."sleep"."source_batch_id" IS '来源批次 ID，用于追踪 Telegram 批次或导入批次';
COMMENT ON COLUMN "core"."sleep"."sleep_type" IS '睡眠类型，通常为夜间睡眠或午睡';
COMMENT ON COLUMN "core"."sleep"."bedtime" IS '入睡时间文本，保留截图或识别结果中的原始时分';
COMMENT ON COLUMN "core"."sleep"."wake_time" IS '醒来时间文本，保留截图或识别结果中的原始时分';
COMMENT ON COLUMN "core"."sleep"."night_sleep_minutes" IS '夜间睡眠分钟数';
COMMENT ON COLUMN "core"."sleep"."total_sleep_minutes" IS '总睡眠分钟数，页面睡眠卡片优先使用该字段汇总';
COMMENT ON COLUMN "core"."sleep"."nap_minutes" IS '午睡分钟数，没有午睡记录时为空';
COMMENT ON COLUMN "core"."sleep"."deep_sleep_minutes" IS '深睡分钟数';
COMMENT ON COLUMN "core"."sleep"."light_sleep_minutes" IS '浅睡分钟数';
COMMENT ON COLUMN "core"."sleep"."rem_sleep_minutes" IS '快速眼动 REM 睡眠分钟数';
COMMENT ON COLUMN "core"."sleep"."awake_minutes" IS '睡眠期间清醒分钟数';
COMMENT ON COLUMN "core"."sleep"."sleep_stage_text" IS '睡眠阶段摘要文本，例如深睡、浅睡、REM 的自然语言描述';
COMMENT ON COLUMN "core"."sleep"."sleep_stage_detail" IS '睡眠阶段详情文本或 JSON 字符串，保留更细粒度的阶段信息';
COMMENT ON COLUMN "core"."sleep"."updated_at" IS '该睡眠记录最近更新时间';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_roles"
    WHERE "rolname" = 'training_writer'
  ) THEN
    GRANT USAGE ON SCHEMA "core" TO "training_writer";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."sleep" TO "training_writer";
  END IF;
END
$$;
