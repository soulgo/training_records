/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records
 Source Schema         : monitor

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 13/07/2026 17:27:28
*/


-- ----------------------------
-- Sequence structure for github_action_steps_step_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "monitor"."github_action_steps_step_id_seq";
CREATE SEQUENCE "monitor"."github_action_steps_step_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 9223372036854775807
START 1
CACHE 1;

-- ----------------------------
-- Table structure for github_action_failures
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."github_action_failures";
CREATE TABLE "monitor"."github_action_failures" (
  "failure_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "run_id" int8 NOT NULL,
  "job_id" int8,
  "step_number" int4,
  "failure_level" text COLLATE "pg_catalog"."default" NOT NULL,
  "workflow_name" text COLLATE "pg_catalog"."default",
  "job_name" text COLLATE "pg_catalog"."default",
  "step_name" text COLLATE "pg_catalog"."default",
  "conclusion" text COLLATE "pg_catalog"."default",
  "error_summary" text COLLATE "pg_catalog"."default" NOT NULL,
  "context_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."github_action_failures"."failure_key" IS '失败记录幂等键，由 run_id、job_id、step_number 和失败层级生成';
COMMENT ON COLUMN "monitor"."github_action_failures"."run_id" IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN "monitor"."github_action_failures"."job_id" IS '所属 GitHub Action Job ID，run 级失败可为空';
COMMENT ON COLUMN "monitor"."github_action_failures"."step_number" IS '失败 Step 序号，job/run 级失败可为空';
COMMENT ON COLUMN "monitor"."github_action_failures"."failure_level" IS '失败层级：run、job、step';
COMMENT ON COLUMN "monitor"."github_action_failures"."workflow_name" IS 'Workflow 名称冗余快照，便于失败分析';
COMMENT ON COLUMN "monitor"."github_action_failures"."job_name" IS 'Job 名称快照';
COMMENT ON COLUMN "monitor"."github_action_failures"."step_name" IS 'Step 名称快照';
COMMENT ON COLUMN "monitor"."github_action_failures"."conclusion" IS '失败结论';
COMMENT ON COLUMN "monitor"."github_action_failures"."error_summary" IS '失败摘要文本';
COMMENT ON COLUMN "monitor"."github_action_failures"."context_json" IS '失败上下文 JSON，用于未来 AI 分析扩展';
COMMENT ON COLUMN "monitor"."github_action_failures"."created_at" IS '失败记录创建时间';
COMMENT ON COLUMN "monitor"."github_action_failures"."updated_at" IS '失败记录更新时间';
COMMENT ON TABLE "monitor"."github_action_failures" IS 'GitHub Actions 失败摘要表，供统计和 AI 失败归因使用';

-- ----------------------------
-- Table structure for github_action_jobs
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."github_action_jobs";
CREATE TABLE "monitor"."github_action_jobs" (
  "job_id" int8 NOT NULL,
  "run_id" int8 NOT NULL,
  "job_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "conclusion" text COLLATE "pg_catalog"."default",
  "start_time" timestamptz(6),
  "end_time" timestamptz(6),
  "duration" int4,
  "html_url" text COLLATE "pg_catalog"."default",
  "runner_name" text COLLATE "pg_catalog"."default",
  "runner_group_name" text COLLATE "pg_catalog"."default",
  "labels_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "raw_payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."github_action_jobs"."job_id" IS 'GitHub Action Job 唯一 ID';
COMMENT ON COLUMN "monitor"."github_action_jobs"."run_id" IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN "monitor"."github_action_jobs"."job_name" IS 'Job 名称';
COMMENT ON COLUMN "monitor"."github_action_jobs"."status" IS 'Job 运行状态';
COMMENT ON COLUMN "monitor"."github_action_jobs"."conclusion" IS 'Job 执行结果';
COMMENT ON COLUMN "monitor"."github_action_jobs"."start_time" IS 'Job 开始时间';
COMMENT ON COLUMN "monitor"."github_action_jobs"."end_time" IS 'Job 结束时间';
COMMENT ON COLUMN "monitor"."github_action_jobs"."duration" IS 'Job 执行耗时（秒）';
COMMENT ON COLUMN "monitor"."github_action_jobs"."html_url" IS 'GitHub Job 页面地址';
COMMENT ON COLUMN "monitor"."github_action_jobs"."runner_name" IS 'Runner 名称';
COMMENT ON COLUMN "monitor"."github_action_jobs"."runner_group_name" IS 'Runner 分组名称';
COMMENT ON COLUMN "monitor"."github_action_jobs"."labels_json" IS 'Runner labels JSON 数组';
COMMENT ON COLUMN "monitor"."github_action_jobs"."raw_payload_json" IS 'GitHub job API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN "monitor"."github_action_jobs"."created_at" IS '监控记录创建时间';
COMMENT ON COLUMN "monitor"."github_action_jobs"."updated_at" IS '监控记录更新时间';
COMMENT ON TABLE "monitor"."github_action_jobs" IS 'GitHub Actions job 明细表，每个 job_id 一行';

-- ----------------------------
-- Table structure for github_action_runs
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."github_action_runs";
CREATE TABLE "monitor"."github_action_runs" (
  "run_id" int8 NOT NULL,
  "repository_full_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "workflow_id" int8,
  "workflow_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "workflow_path" text COLLATE "pg_catalog"."default",
  "run_number" int4,
  "run_attempt" int4,
  "event" text COLLATE "pg_catalog"."default",
  "branch" text COLLATE "pg_catalog"."default",
  "commit_sha" text COLLATE "pg_catalog"."default",
  "head_commit_message" text COLLATE "pg_catalog"."default",
  "actor_login" text COLLATE "pg_catalog"."default",
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "conclusion" text COLLATE "pg_catalog"."default",
  "start_time" timestamptz(6),
  "end_time" timestamptz(6),
  "duration" int4,
  "html_url" text COLLATE "pg_catalog"."default",
  "error_summary" text COLLATE "pg_catalog"."default",
  "raw_payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."github_action_runs"."run_id" IS 'GitHub Action Run 唯一 ID';
COMMENT ON COLUMN "monitor"."github_action_runs"."repository_full_name" IS '仓库全名，例如 soulgo/training_records';
COMMENT ON COLUMN "monitor"."github_action_runs"."workflow_id" IS 'GitHub Workflow ID';
COMMENT ON COLUMN "monitor"."github_action_runs"."workflow_name" IS 'Workflow 名称';
COMMENT ON COLUMN "monitor"."github_action_runs"."workflow_path" IS 'Workflow 文件路径，例如 .github/workflows/sync.yml';
COMMENT ON COLUMN "monitor"."github_action_runs"."run_number" IS 'Workflow 内递增运行编号';
COMMENT ON COLUMN "monitor"."github_action_runs"."run_attempt" IS '同一 run 的尝试次数';
COMMENT ON COLUMN "monitor"."github_action_runs"."event" IS '触发事件，例如 push、workflow_dispatch、repository_dispatch、schedule';
COMMENT ON COLUMN "monitor"."github_action_runs"."branch" IS '运行分支（dev/main 或其它分支）';
COMMENT ON COLUMN "monitor"."github_action_runs"."commit_sha" IS '提交 SHA';
COMMENT ON COLUMN "monitor"."github_action_runs"."head_commit_message" IS 'Head commit 提交信息摘要';
COMMENT ON COLUMN "monitor"."github_action_runs"."actor_login" IS '触发人或 bot 登录名';
COMMENT ON COLUMN "monitor"."github_action_runs"."status" IS '运行状态，例如 queued、in_progress、completed';
COMMENT ON COLUMN "monitor"."github_action_runs"."conclusion" IS '执行结果（success/failure/cancelled/skipped/timed_out/action_required）';
COMMENT ON COLUMN "monitor"."github_action_runs"."start_time" IS '开始时间';
COMMENT ON COLUMN "monitor"."github_action_runs"."end_time" IS '结束时间';
COMMENT ON COLUMN "monitor"."github_action_runs"."duration" IS '执行耗时（秒）';
COMMENT ON COLUMN "monitor"."github_action_runs"."html_url" IS 'GitHub Run 页面地址';
COMMENT ON COLUMN "monitor"."github_action_runs"."error_summary" IS '失败摘要，优先由失败 job/step 生成';
COMMENT ON COLUMN "monitor"."github_action_runs"."raw_payload_json" IS 'GitHub workflow run API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN "monitor"."github_action_runs"."created_at" IS '监控记录创建时间';
COMMENT ON COLUMN "monitor"."github_action_runs"."updated_at" IS '监控记录更新时间';
COMMENT ON TABLE "monitor"."github_action_runs" IS 'GitHub Actions workflow run 生命周期主表，每个 run_id 一行';

-- ----------------------------
-- Table structure for github_action_steps
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."github_action_steps";
CREATE TABLE "monitor"."github_action_steps" (
  "step_id" int8 NOT NULL DEFAULT nextval('"monitor".github_action_steps_step_id_seq'::regclass),
  "job_id" int8 NOT NULL,
  "run_id" int8 NOT NULL,
  "step_number" int4 NOT NULL,
  "step_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "conclusion" text COLLATE "pg_catalog"."default",
  "start_time" timestamptz(6),
  "end_time" timestamptz(6),
  "duration" int4,
  "raw_payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."github_action_steps"."step_id" IS '本地 step 自增主键';
COMMENT ON COLUMN "monitor"."github_action_steps"."job_id" IS '所属 GitHub Action Job ID';
COMMENT ON COLUMN "monitor"."github_action_steps"."run_id" IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN "monitor"."github_action_steps"."step_number" IS 'Step 序号';
COMMENT ON COLUMN "monitor"."github_action_steps"."step_name" IS 'Step 名称';
COMMENT ON COLUMN "monitor"."github_action_steps"."status" IS 'Step 运行状态';
COMMENT ON COLUMN "monitor"."github_action_steps"."conclusion" IS 'Step 执行结果';
COMMENT ON COLUMN "monitor"."github_action_steps"."start_time" IS 'Step 开始时间';
COMMENT ON COLUMN "monitor"."github_action_steps"."end_time" IS 'Step 结束时间';
COMMENT ON COLUMN "monitor"."github_action_steps"."duration" IS 'Step 执行耗时（秒）';
COMMENT ON COLUMN "monitor"."github_action_steps"."raw_payload_json" IS 'GitHub step API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN "monitor"."github_action_steps"."created_at" IS '监控记录创建时间';
COMMENT ON COLUMN "monitor"."github_action_steps"."updated_at" IS '监控记录更新时间';
COMMENT ON TABLE "monitor"."github_action_steps" IS 'GitHub Actions step 明细表，每个 job 的 step_number 唯一';

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "monitor"."github_action_steps_step_id_seq"
OWNED BY "monitor"."github_action_steps"."step_id";
SELECT setval('"monitor"."github_action_steps_step_id_seq"', 1370, true);

-- ----------------------------
-- Indexes structure for table github_action_failures
-- ----------------------------
CREATE INDEX "idx_github_action_failures_run_id" ON "monitor"."github_action_failures" USING btree (
  "run_id" "pg_catalog"."int8_ops" ASC NULLS LAST
);
CREATE INDEX "idx_github_action_failures_workflow_time" ON "monitor"."github_action_failures" USING btree (
  "workflow_name" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "created_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);

-- ----------------------------
-- Primary Key structure for table github_action_failures
-- ----------------------------
ALTER TABLE "monitor"."github_action_failures" ADD CONSTRAINT "github_action_failures_pkey" PRIMARY KEY ("failure_key");

-- ----------------------------
-- Indexes structure for table github_action_jobs
-- ----------------------------
CREATE INDEX "idx_github_action_jobs_conclusion" ON "monitor"."github_action_jobs" USING btree (
  "conclusion" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "idx_github_action_jobs_run_id" ON "monitor"."github_action_jobs" USING btree (
  "run_id" "pg_catalog"."int8_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for table github_action_jobs
-- ----------------------------
ALTER TABLE "monitor"."github_action_jobs" ADD CONSTRAINT "github_action_jobs_pkey" PRIMARY KEY ("job_id");

-- ----------------------------
-- Indexes structure for table github_action_runs
-- ----------------------------
CREATE INDEX "idx_github_action_runs_commit_sha" ON "monitor"."github_action_runs" USING btree (
  "commit_sha" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "idx_github_action_runs_conclusion_time" ON "monitor"."github_action_runs" USING btree (
  "conclusion" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "created_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE INDEX "idx_github_action_runs_workflow_branch_time" ON "monitor"."github_action_runs" USING btree (
  "workflow_name" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "branch" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "created_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);

-- ----------------------------
-- Primary Key structure for table github_action_runs
-- ----------------------------
ALTER TABLE "monitor"."github_action_runs" ADD CONSTRAINT "github_action_runs_pkey" PRIMARY KEY ("run_id");

-- ----------------------------
-- Indexes structure for table github_action_steps
-- ----------------------------
CREATE INDEX "idx_github_action_steps_conclusion" ON "monitor"."github_action_steps" USING btree (
  "conclusion" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "idx_github_action_steps_run_id" ON "monitor"."github_action_steps" USING btree (
  "run_id" "pg_catalog"."int8_ops" ASC NULLS LAST
);

-- ----------------------------
-- Uniques structure for table github_action_steps
-- ----------------------------
ALTER TABLE "monitor"."github_action_steps" ADD CONSTRAINT "ux_github_action_steps_job_number" UNIQUE ("job_id", "step_number");

-- ----------------------------
-- Primary Key structure for table github_action_steps
-- ----------------------------
ALTER TABLE "monitor"."github_action_steps" ADD CONSTRAINT "github_action_steps_pkey" PRIMARY KEY ("step_id");

-- ----------------------------
-- Foreign Keys structure for table github_action_failures
-- ----------------------------
ALTER TABLE "monitor"."github_action_failures" ADD CONSTRAINT "github_action_failures_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "monitor"."github_action_jobs" ("job_id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "monitor"."github_action_failures" ADD CONSTRAINT "github_action_failures_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "monitor"."github_action_runs" ("run_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table github_action_jobs
-- ----------------------------
ALTER TABLE "monitor"."github_action_jobs" ADD CONSTRAINT "github_action_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "monitor"."github_action_runs" ("run_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table github_action_steps
-- ----------------------------
ALTER TABLE "monitor"."github_action_steps" ADD CONSTRAINT "github_action_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "monitor"."github_action_jobs" ("job_id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "monitor"."github_action_steps" ADD CONSTRAINT "github_action_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "monitor"."github_action_runs" ("run_id") ON DELETE CASCADE ON UPDATE NO ACTION;
