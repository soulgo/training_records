/*
 Navicat Premium Dump SQL

 Source Server         : training_records pgsql17
 Source Server Type    : PostgreSQL
 Source Server Version : 170000 (170000)
 Source Host           : 122.51.66.213:15432
 Source Catalog        : training_records_dev
 Source Schema         : monitor

 Target Server Type    : PostgreSQL
 Target Server Version : 170000 (170000)
 File Encoding         : 65001

 Date: 10/07/2026 14:11:26
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
-- Sequence structure for system_config_parameter_checks_check_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "monitor"."system_config_parameter_checks_check_id_seq";
CREATE SEQUENCE "monitor"."system_config_parameter_checks_check_id_seq" 
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
-- Table structure for system_config_parameter_checks
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."system_config_parameter_checks";
CREATE TABLE "monitor"."system_config_parameter_checks" (
  "check_id" int8 NOT NULL DEFAULT nextval('"monitor".system_config_parameter_checks_check_id_seq'::regclass),
  "parameter_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "monitor_environment" text COLLATE "pg_catalog"."default" NOT NULL,
  "run_id" int8,
  "checked_at" timestamptz(6) NOT NULL DEFAULT now(),
  "status" text COLLATE "pg_catalog"."default" NOT NULL,
  "check_type" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'unsupported'::text,
  "latency_ms" int4,
  "failure_kind" text COLLATE "pg_catalog"."default",
  "observed_expires_at" timestamptz(6),
  "days_until_due" int4,
  "evidence_source" text COLLATE "pg_catalog"."default" NOT NULL,
  "message" text COLLATE "pg_catalog"."default",
  "details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."check_id" IS '检查结果自增主键';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."parameter_key" IS '被检查参数主键，关联 monitor.system_config_parameters.parameter_key';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."monitor_environment" IS '本次检查所属监控环境，例如 dev 或 main';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."run_id" IS '触发本次检查的 GitHub Action run_id，可为空；为空表示本地维护命令或非 Action 来源';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."checked_at" IS '本次参数健康检查时间';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."status" IS '健康状态：healthy、present、invalid、missing、not_configured、unreachable、unsupported、unknown';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."check_type" IS '本次健康探测类型，例如 postgres_connect、telegram_get_me、presence、unsupported';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."latency_ms" IS '健康探测耗时毫秒；未执行主动探测时可为 0 或空';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."failure_kind" IS '失败分类，例如 credential_missing、authentication、network、timeout、provider_error、no_safe_probe';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."observed_expires_at" IS 'Provider 真实返回的到期时间；没有可靠到期证据时为空，不参与健康状态判定';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."days_until_due" IS '距离真实或登记到期/复核日期的剩余天数；仅作为附加到期证据';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."evidence_source" IS '状态证据来源，例如 active_probe:postgres_connect、runtime_env_presence、registry';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."message" IS '给页面和 summary 使用的简短处理提示，不包含敏感值';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."details_json" IS '非敏感检查细节 JSON，例如 healthProbeKey、expiryStatus、Provider 非敏感响应摘要';
COMMENT ON COLUMN "monitor"."system_config_parameter_checks"."created_at" IS '检查结果记录创建时间';
COMMENT ON TABLE "monitor"."system_config_parameter_checks" IS '系统配置参数健康检查结果表，记录每次 audit 对参数的健康探测结论';

-- ----------------------------
-- Table structure for system_config_parameters
-- ----------------------------
DROP TABLE IF EXISTS "monitor"."system_config_parameters";
CREATE TABLE "monitor"."system_config_parameters" (
  "parameter_key" text COLLATE "pg_catalog"."default" NOT NULL,
  "monitor_environment" text COLLATE "pg_catalog"."default" NOT NULL,
  "parameter_name" text COLLATE "pg_catalog"."default" NOT NULL,
  "scope" text COLLATE "pg_catalog"."default" NOT NULL,
  "category" text COLLATE "pg_catalog"."default" NOT NULL,
  "required" bool NOT NULL DEFAULT false,
  "sensitive" bool NOT NULL DEFAULT true,
  "health_probe_key" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'legacy_unconfigured'::text,
  "health_check_type" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'unsupported'::text,
  "validity_mode" text COLLATE "pg_catalog"."default" NOT NULL,
  "valid_from" timestamptz(6),
  "expires_at" timestamptz(6),
  "review_after_at" timestamptz(6),
  "rotation_cycle_days" int4,
  "warning_days" int4 NOT NULL DEFAULT 30,
  "critical_days" int4 NOT NULL DEFAULT 7,
  "owner" text COLLATE "pg_catalog"."default",
  "source_doc" text COLLATE "pg_catalog"."default",
  "source_code_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
)
;
COMMENT ON COLUMN "monitor"."system_config_parameters"."parameter_key" IS '参数稳定主键，建议格式为 <env>.<scope>.<name>，例如 dev.github.secret.DEV_TRAINING_DB_URL';
COMMENT ON COLUMN "monitor"."system_config_parameters"."monitor_environment" IS '监控环境，例如 dev 或 main，用于分库/分支隔离展示';
COMMENT ON COLUMN "monitor"."system_config_parameters"."parameter_name" IS '参数名称，只保存配置项名称，不保存配置值';
COMMENT ON COLUMN "monitor"."system_config_parameters"."scope" IS '参数所在范围，例如 github_actions_secret、github_actions_variable、cloudflare_worker_secret、wrangler_var、runtime_env、config_file';
COMMENT ON COLUMN "monitor"."system_config_parameters"."category" IS '参数业务分类，例如 database、ai、telegram、feishu、cos、cloudflare、github、monitor、site';
COMMENT ON COLUMN "monitor"."system_config_parameters"."required" IS '是否为当前环境必填参数，必填参数缺失时检查状态应为 missing';
COMMENT ON COLUMN "monitor"."system_config_parameters"."sensitive" IS '是否为敏感参数；敏感参数禁止展示值、部分值或 value hash';
COMMENT ON COLUMN "monitor"."system_config_parameters"."health_probe_key" IS '参数引用的健康探测定义 key；探测定义维护在 config/parameter-health/<env>.json，不保存凭证值';
COMMENT ON COLUMN "monitor"."system_config_parameters"."health_check_type" IS '健康探测类型快照，例如 postgres_connect、openai_models、telegram_get_me、presence、unsupported';
COMMENT ON COLUMN "monitor"."system_config_parameters"."validity_mode" IS '可选到期证据维护模式，例如 fixed_expires_at、rotation_cycle、review_after、non_expiring_manual_review、provider_metadata';
COMMENT ON COLUMN "monitor"."system_config_parameters"."valid_from" IS '参数开始使用时间，可作为轮换周期计算起点';
COMMENT ON COLUMN "monitor"."system_config_parameters"."expires_at" IS '登记的明确过期时间；仅作为页面到期证据，不代表健康探测结果';
COMMENT ON COLUMN "monitor"."system_config_parameters"."review_after_at" IS '复核时间；适用于没有真实过期时间但需要定期确认仍有效的配置';
COMMENT ON COLUMN "monitor"."system_config_parameters"."rotation_cycle_days" IS '轮换周期天数；配合 valid_from 或 provider metadata updated_at 计算下一次复核时间';
COMMENT ON COLUMN "monitor"."system_config_parameters"."warning_days" IS '到期或复核前预警天数，默认 30 天';
COMMENT ON COLUMN "monitor"."system_config_parameters"."critical_days" IS '到期或复核前高危提醒天数，默认 7 天';
COMMENT ON COLUMN "monitor"."system_config_parameters"."owner" IS '参数维护责任方或责任人标识';
COMMENT ON COLUMN "monitor"."system_config_parameters"."source_doc" IS '参数来源文档路径，例如 docs/01_系统配置/dev.md';
COMMENT ON COLUMN "monitor"."system_config_parameters"."source_code_json" IS '读取或注入该参数的代码、workflow 或配置文件路径 JSON 数组';
COMMENT ON COLUMN "monitor"."system_config_parameters"."metadata_json" IS '非敏感补充元数据，例如维护说明、Provider 非敏感元数据等，不保存参数值';
COMMENT ON COLUMN "monitor"."system_config_parameters"."created_at" IS '监控参数记录创建时间';
COMMENT ON COLUMN "monitor"."system_config_parameters"."updated_at" IS '监控参数记录更新时间';
COMMENT ON TABLE "monitor"."system_config_parameters" IS '系统配置参数健康主表，记录每个需监控参数的健康探测、可选到期证据和维护来源，不保存参数值';

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "monitor"."github_action_steps_step_id_seq"
OWNED BY "monitor"."github_action_steps"."step_id";
SELECT setval('"monitor"."github_action_steps_step_id_seq"', 539, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "monitor"."system_config_parameter_checks_check_id_seq"
OWNED BY "monitor"."system_config_parameter_checks"."check_id";
SELECT setval('"monitor"."system_config_parameter_checks_check_id_seq"', 1, false);

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
-- Indexes structure for table system_config_parameter_checks
-- ----------------------------
CREATE INDEX "idx_system_config_parameter_checks_env_time" ON "monitor"."system_config_parameter_checks" USING btree (
  "monitor_environment" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "checked_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE INDEX "idx_system_config_parameter_checks_status_time" ON "monitor"."system_config_parameter_checks" USING btree (
  "monitor_environment" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "status" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "checked_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
);
CREATE INDEX "idx_system_config_parameter_checks_last_healthy" ON "monitor"."system_config_parameter_checks" USING btree (
  "parameter_key" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "checked_at" "pg_catalog"."timestamptz_ops" DESC NULLS FIRST
) WHERE "status" = 'healthy'::text;

-- ----------------------------
-- Primary Key structure for table system_config_parameter_checks
-- ----------------------------
ALTER TABLE "monitor"."system_config_parameter_checks" ADD CONSTRAINT "system_config_parameter_checks_pkey" PRIMARY KEY ("check_id");
ALTER TABLE "monitor"."system_config_parameter_checks" ADD CONSTRAINT "ck_system_config_parameter_checks_health_status" CHECK ("status" = ANY (ARRAY['healthy'::text, 'present'::text, 'invalid'::text, 'missing'::text, 'not_configured'::text, 'unreachable'::text, 'unsupported'::text, 'unknown'::text]));

-- ----------------------------
-- Primary Key structure for table system_config_parameters
-- ----------------------------
ALTER TABLE "monitor"."system_config_parameters" ADD CONSTRAINT "system_config_parameters_pkey" PRIMARY KEY ("parameter_key");

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

-- ----------------------------
-- Foreign Keys structure for table system_config_parameter_checks
-- ----------------------------
ALTER TABLE "monitor"."system_config_parameter_checks" ADD CONSTRAINT "system_config_parameter_checks_parameter_key_fkey" FOREIGN KEY ("parameter_key") REFERENCES "monitor"."system_config_parameters" ("parameter_key") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "monitor"."system_config_parameter_checks" ADD CONSTRAINT "system_config_parameter_checks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "monitor"."github_action_runs" ("run_id") ON DELETE SET NULL ON UPDATE NO ACTION;
