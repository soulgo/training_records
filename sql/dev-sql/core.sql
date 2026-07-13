/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records_dev
 Source Schema         : core

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 13/07/2026 17:20:54
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
-- Table structure for sleep
-- ----------------------------
DROP TABLE IF EXISTS "core"."sleep";
CREATE TABLE "core"."sleep" (
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
  "updated_at" timestamptz(6) NOT NULL,
  "sleep_score" int4,
  "sleep_score_percentile" int4,
  "deep_sleep_ratio_pct" numeric(10,2),
  "light_sleep_ratio_pct" numeric(10,2),
  "rem_sleep_ratio_pct" numeric(10,2),
  "deep_sleep_continuity_score" int4,
  "wake_count" int4,
  "breathing_quality_score" int4,
  "average_heart_rate_bpm" int4,
  "hrv_ms" int4,
  "average_spo2_pct" numeric(10,2),
  "average_respiratory_rate" numeric(10,2),
  "analysis_text" text COLLATE "pg_catalog"."default",
  "suggestion_text" text COLLATE "pg_catalog"."default"
)
;
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
COMMENT ON TABLE "core"."sleep" IS '核心训练睡眠明细表，Telegram 或 Markdown 解析后的每条睡眠记录一行';

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
  "thought_module" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'workout'::text,
  "tags_json" jsonb NOT NULL DEFAULT '["训练", "随想", "Telegram"]'::jsonb,
  "message_date_unix" int8,
  "markdown_path" text COLLATE "pg_catalog"."default",
  "image_refs_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'active'::text,
  "deleted_at" timestamptz(6),
  "updated_at" timestamptz(6) NOT NULL,
  "source_channel" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'telegram'::text,
  "source_chat_id" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'legacy-chat'::text,
  "source_message_id" text COLLATE "pg_catalog"."default" NOT NULL
)
;
COMMENT ON COLUMN "core"."thought"."telegram_message_id" IS '原 Telegram message_id，也是随想的稳定定位 ID';
COMMENT ON COLUMN "core"."thought"."body" IS '随想正文文本，不包含图片二进制';
COMMENT ON COLUMN "core"."thought"."thought_module" IS '随想模块：workout 为锻炼随想，misc 为杂七杂八，body_feedback 为身体反馈；历史缺省按 workout 兼容';
COMMENT ON COLUMN "core"."thought"."markdown_path" IS '当前 Markdown 兼容层路径，例如 source/_posts/YYYY-MM-DD-telegram-thought-501.md';
COMMENT ON COLUMN "core"."thought"."image_refs_json" IS '有序图片引用清单，当前为 /images/thoughts/...，后续可切换为 OSS object key 或 URL';
COMMENT ON COLUMN "core"."thought"."status" IS 'active 或 deleted；删除命令使用软删除保留迁移线索';
COMMENT ON COLUMN "core"."thought"."source_channel" IS '来源通道，例如 telegram、feishu、markdown_import';
COMMENT ON COLUMN "core"."thought"."source_chat_id" IS '来源 chat/conversation ID，Telegram 为 chat_id，飞书为 chat_id 原始字符串';
COMMENT ON COLUMN "core"."thought"."source_message_id" IS '来源消息 ID，Telegram 为 message_id，飞书为 message_id 原始字符串';
COMMENT ON TABLE "core"."thought" IS '锻炼随想正文镜像表；图片仍保存在本地目录或后续对象存储，表内只保存引用';

-- ----------------------------
-- Table structure for trainee_profile
-- ----------------------------
DROP TABLE IF EXISTS "core"."trainee_profile";
CREATE TABLE "core"."trainee_profile" (
  "trainee_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "timezone" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'Asia/Shanghai'::text,
  "birth_date" date,
  "sex_at_birth" text COLLATE "pg_catalog"."default",
  "height_cm" numeric(5,2),
  "experience_level" text COLLATE "pg_catalog"."default",
  "goal_text" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。'::text,
  "weekly_training_days_target" int2,
  "profile_json" jsonb NOT NULL DEFAULT jsonb_build_object('availableEquipment', '[]'::jsonb, 'chronicLimitations', '[]'::jsonb, 'preferredActivities', '[]'::jsonb, 'scheduleNotes', NULL::unknown),
  "profile_version" int4 NOT NULL DEFAULT 1,
  "is_active" bool NOT NULL DEFAULT true,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "core"."trainee_profile"."trainee_id" IS '系统内训练者身份；当前单用户使用 default，保留未来多训练者扩展能力';
COMMENT ON COLUMN "core"."trainee_profile"."timezone" IS '训练者 IANA 时区，用于日期窗口和年龄计算';
COMMENT ON COLUMN "core"."trainee_profile"."birth_date" IS '出生日期；年龄在分析时计算，不存储 age';
COMMENT ON COLUMN "core"."trainee_profile"."sex_at_birth" IS '可选生理性别输入，仅在确有运动科学计算需要时使用；undisclosed 表示不提供';
COMMENT ON COLUMN "core"."trainee_profile"."height_cm" IS '身高厘米；用于需要身高的派生指标，不复制体测表中的动态数据';
COMMENT ON COLUMN "core"."trainee_profile"."experience_level" IS '训练经验等级：beginner、intermediate、advanced 或 unknown';
COMMENT ON COLUMN "core"."trainee_profile"."goal_text" IS '训练者当前长期目标原文，直接进入分析上下文，不由后端猜测';
COMMENT ON COLUMN "core"."trainee_profile"."weekly_training_days_target" IS '用户期望的每周训练天数；为空表示不设置硬目标';
COMMENT ON COLUMN "core"."trainee_profile"."profile_json" IS '不参与主查询的可演进画像配置：可用器械、长期限制、偏好活动和日程说明';
COMMENT ON COLUMN "core"."trainee_profile"."profile_version" IS '画像乐观更新版本；每次业务更新递增，用于分析上下文审计';
COMMENT ON COLUMN "core"."trainee_profile"."is_active" IS '是否为可用于分析的有效画像';
COMMENT ON TABLE "core"."trainee_profile" IS '训练者稳定画像；供训练分析限定目标、经验、长期限制与可用器械，不复制动态训练和健康事实';

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
  "updated_at" timestamptz(6) NOT NULL,
  "sleep_total_minutes" int4,
  "night_sleep_minutes" int4,
  "nap_minutes" int4,
  "sleep_start_time" text COLLATE "pg_catalog"."default",
  "sleep_end_time" text COLLATE "pg_catalog"."default",
  "deep_sleep_minutes" int4,
  "light_sleep_minutes" int4,
  "rem_sleep_minutes" int4,
  "awake_minutes" int4
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
-- Primary Key structure for table meal
-- ----------------------------
ALTER TABLE "core"."meal" ADD CONSTRAINT "meal_pkey" PRIMARY KEY ("meal_key");

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
-- Indexes structure for table sleep
-- ----------------------------
CREATE INDEX "idx_core_sleep_archived_date" ON "core"."sleep" USING btree (
  "archived_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table sleep
-- ----------------------------
ALTER TABLE "core"."sleep" ADD CONSTRAINT "sleep_pkey" PRIMARY KEY ("sleep_key");

-- ----------------------------
-- Indexes structure for table thought
-- ----------------------------
CREATE INDEX "idx_core_thought_module_updated_at" ON "core"."thought" USING btree (
  "thought_module" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "updated_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE INDEX "idx_core_thought_updated_at" ON "core"."thought" USING btree (
  "updated_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE UNIQUE INDEX "ux_core_thought_identity" ON "core"."thought" USING btree (
  "source_channel" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_chat_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "source_message_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table thought
-- ----------------------------
ALTER TABLE "core"."thought" ADD CONSTRAINT "thought_pkey" PRIMARY KEY ("telegram_message_id");

-- ----------------------------
-- Checks structure for table trainee_profile
-- ----------------------------
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_timezone" CHECK (btrim(timezone) <> ''::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_birth_date" CHECK (birth_date IS NULL OR birth_date >= '1900-01-01'::date);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_sex_at_birth" CHECK (sex_at_birth IS NULL OR (sex_at_birth = ANY (ARRAY['female'::text, 'male'::text, 'intersex'::text, 'undisclosed'::text])));
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_height" CHECK (height_cm IS NULL OR height_cm >= 80::numeric AND height_cm <= 250::numeric);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_experience" CHECK (experience_level IS NULL OR (experience_level = ANY (ARRAY['beginner'::text, 'intermediate'::text, 'advanced'::text, 'unknown'::text])));
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_goal" CHECK (btrim(goal_text) <> ''::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_id" CHECK (btrim(trainee_id) <> ''::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_json_object" CHECK (jsonb_typeof(profile_json) = 'object'::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_equipment_array" CHECK (NOT profile_json ? 'availableEquipment'::text OR jsonb_typeof(profile_json -> 'availableEquipment'::text) = 'array'::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_limitations_array" CHECK (NOT profile_json ? 'chronicLimitations'::text OR jsonb_typeof(profile_json -> 'chronicLimitations'::text) = 'array'::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_activities_array" CHECK (NOT profile_json ? 'preferredActivities'::text OR jsonb_typeof(profile_json -> 'preferredActivities'::text) = 'array'::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_schedule_notes" CHECK (NOT profile_json ? 'scheduleNotes'::text OR (profile_json -> 'scheduleNotes'::text) = 'null'::jsonb OR jsonb_typeof(profile_json -> 'scheduleNotes'::text) = 'string'::text);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_version" CHECK (profile_version >= 1);
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "ck_trainee_profile_weekly_days" CHECK (weekly_training_days_target IS NULL OR weekly_training_days_target >= 1 AND weekly_training_days_target <= 7);

-- ----------------------------
-- Primary Key structure for table trainee_profile
-- ----------------------------
ALTER TABLE "core"."trainee_profile" ADD CONSTRAINT "trainee_profile_pkey" PRIMARY KEY ("trainee_id");

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

-- ----------------------------
-- Foreign Keys structure for table sleep
-- ----------------------------
ALTER TABLE "core"."sleep" ADD CONSTRAINT "sleep_archived_date_fkey" FOREIGN KEY ("archived_date") REFERENCES "core"."training_day" ("archived_date") ON DELETE CASCADE ON UPDATE NO ACTION;
