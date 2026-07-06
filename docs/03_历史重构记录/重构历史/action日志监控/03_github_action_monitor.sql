-- GitHub Action monitor schema.
--
-- 手动创建环境说明：
-- 1. dev 分支 / dev 数据库执行本 SQL 后，监控服务使用：
--    GITHUB_ACTION_MONITOR_ENVIRONMENT=dev
--    GITHUB_ACTION_MONITOR_ALLOWED_BRANCH=dev
--    GITHUB_ACTION_MONITOR_DB_URL=<dev PostgreSQL URL>
-- 2. main 分支 / main 数据库执行本 SQL 后，监控服务使用：
--    GITHUB_ACTION_MONITOR_ENVIRONMENT=main
--    GITHUB_ACTION_MONITOR_ALLOWED_BRANCH=main
--    GITHUB_ACTION_MONITOR_DB_URL=<main PostgreSQL URL>
-- 3. dev 与 main 分别建表、分别写库；同一监控实例禁止同时写入 dev/main 两个分支的数据。

CREATE SCHEMA IF NOT EXISTS monitor;

CREATE TABLE IF NOT EXISTS monitor.github_action_runs (
  run_id bigint PRIMARY KEY,
  repository_full_name text NOT NULL,
  monitor_environment text NOT NULL,
  workflow_id bigint,
  workflow_name text NOT NULL,
  workflow_path text,
  run_number integer,
  run_attempt integer,
  event text,
  branch text,
  commit_sha text,
  head_commit_message text,
  actor_login text,
  status text NOT NULL,
  conclusion text,
  start_time timestamptz,
  end_time timestamptz,
  duration integer,
  html_url text,
  error_summary text,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE monitor.github_action_runs IS 'GitHub Actions workflow run 生命周期主表，每个 run_id 一行';
COMMENT ON COLUMN monitor.github_action_runs.run_id IS 'GitHub Action Run 唯一 ID';
COMMENT ON COLUMN monitor.github_action_runs.repository_full_name IS '仓库全名，例如 soulgo/training_records';
COMMENT ON COLUMN monitor.github_action_runs.monitor_environment IS '监控环境：dev 或 main';
COMMENT ON COLUMN monitor.github_action_runs.workflow_id IS 'GitHub Workflow ID';
COMMENT ON COLUMN monitor.github_action_runs.workflow_name IS 'Workflow 名称';
COMMENT ON COLUMN monitor.github_action_runs.workflow_path IS 'Workflow 文件路径，例如 .github/workflows/sync.yml';
COMMENT ON COLUMN monitor.github_action_runs.run_number IS 'Workflow 内递增运行编号';
COMMENT ON COLUMN monitor.github_action_runs.run_attempt IS '同一 run 的尝试次数';
COMMENT ON COLUMN monitor.github_action_runs.event IS '触发事件，例如 push、workflow_dispatch、repository_dispatch、schedule';
COMMENT ON COLUMN monitor.github_action_runs.branch IS '运行分支（dev/main 或其它分支）';
COMMENT ON COLUMN monitor.github_action_runs.commit_sha IS '提交 SHA';
COMMENT ON COLUMN monitor.github_action_runs.head_commit_message IS 'Head commit 提交信息摘要';
COMMENT ON COLUMN monitor.github_action_runs.actor_login IS '触发人或 bot 登录名';
COMMENT ON COLUMN monitor.github_action_runs.status IS '运行状态，例如 queued、in_progress、completed';
COMMENT ON COLUMN monitor.github_action_runs.conclusion IS '执行结果（success/failure/cancelled/skipped/timed_out/action_required）';
COMMENT ON COLUMN monitor.github_action_runs.start_time IS '开始时间';
COMMENT ON COLUMN monitor.github_action_runs.end_time IS '结束时间';
COMMENT ON COLUMN monitor.github_action_runs.duration IS '执行耗时（秒）';
COMMENT ON COLUMN monitor.github_action_runs.html_url IS 'GitHub Run 页面地址';
COMMENT ON COLUMN monitor.github_action_runs.error_summary IS '失败摘要，优先由失败 job/step 生成';
COMMENT ON COLUMN monitor.github_action_runs.raw_payload_json IS 'GitHub workflow run API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN monitor.github_action_runs.created_at IS '监控记录创建时间';
COMMENT ON COLUMN monitor.github_action_runs.updated_at IS '监控记录更新时间';

CREATE INDEX IF NOT EXISTS idx_github_action_runs_workflow_branch_time
  ON monitor.github_action_runs (monitor_environment, workflow_name, branch, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_action_runs_conclusion_time
  ON monitor.github_action_runs (monitor_environment, conclusion, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_action_runs_commit_sha
  ON monitor.github_action_runs (commit_sha);

CREATE TABLE IF NOT EXISTS monitor.github_action_jobs (
  job_id bigint PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES monitor.github_action_runs(run_id) ON DELETE CASCADE,
  job_name text NOT NULL,
  status text NOT NULL,
  conclusion text,
  start_time timestamptz,
  end_time timestamptz,
  duration integer,
  html_url text,
  runner_name text,
  runner_group_name text,
  labels_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE monitor.github_action_jobs IS 'GitHub Actions job 明细表，每个 job_id 一行';
COMMENT ON COLUMN monitor.github_action_jobs.job_id IS 'GitHub Action Job 唯一 ID';
COMMENT ON COLUMN monitor.github_action_jobs.run_id IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN monitor.github_action_jobs.job_name IS 'Job 名称';
COMMENT ON COLUMN monitor.github_action_jobs.status IS 'Job 运行状态';
COMMENT ON COLUMN monitor.github_action_jobs.conclusion IS 'Job 执行结果';
COMMENT ON COLUMN monitor.github_action_jobs.start_time IS 'Job 开始时间';
COMMENT ON COLUMN monitor.github_action_jobs.end_time IS 'Job 结束时间';
COMMENT ON COLUMN monitor.github_action_jobs.duration IS 'Job 执行耗时（秒）';
COMMENT ON COLUMN monitor.github_action_jobs.html_url IS 'GitHub Job 页面地址';
COMMENT ON COLUMN monitor.github_action_jobs.runner_name IS 'Runner 名称';
COMMENT ON COLUMN monitor.github_action_jobs.runner_group_name IS 'Runner 分组名称';
COMMENT ON COLUMN monitor.github_action_jobs.labels_json IS 'Runner labels JSON 数组';
COMMENT ON COLUMN monitor.github_action_jobs.raw_payload_json IS 'GitHub job API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN monitor.github_action_jobs.created_at IS '监控记录创建时间';
COMMENT ON COLUMN monitor.github_action_jobs.updated_at IS '监控记录更新时间';

CREATE INDEX IF NOT EXISTS idx_github_action_jobs_run_id
  ON monitor.github_action_jobs (run_id);
CREATE INDEX IF NOT EXISTS idx_github_action_jobs_conclusion
  ON monitor.github_action_jobs (conclusion);

CREATE TABLE IF NOT EXISTS monitor.github_action_steps (
  step_id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES monitor.github_action_jobs(job_id) ON DELETE CASCADE,
  run_id bigint NOT NULL REFERENCES monitor.github_action_runs(run_id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  step_name text NOT NULL,
  status text NOT NULL,
  conclusion text,
  start_time timestamptz,
  end_time timestamptz,
  duration integer,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_github_action_steps_job_number UNIQUE (job_id, step_number)
);

COMMENT ON TABLE monitor.github_action_steps IS 'GitHub Actions step 明细表，每个 job 的 step_number 唯一';
COMMENT ON COLUMN monitor.github_action_steps.step_id IS '本地 step 自增主键';
COMMENT ON COLUMN monitor.github_action_steps.job_id IS '所属 GitHub Action Job ID';
COMMENT ON COLUMN monitor.github_action_steps.run_id IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN monitor.github_action_steps.step_number IS 'Step 序号';
COMMENT ON COLUMN monitor.github_action_steps.step_name IS 'Step 名称';
COMMENT ON COLUMN monitor.github_action_steps.status IS 'Step 运行状态';
COMMENT ON COLUMN monitor.github_action_steps.conclusion IS 'Step 执行结果';
COMMENT ON COLUMN monitor.github_action_steps.start_time IS 'Step 开始时间';
COMMENT ON COLUMN monitor.github_action_steps.end_time IS 'Step 结束时间';
COMMENT ON COLUMN monitor.github_action_steps.duration IS 'Step 执行耗时（秒）';
COMMENT ON COLUMN monitor.github_action_steps.raw_payload_json IS 'GitHub step API 原始结构化数据，保留扩展字段';
COMMENT ON COLUMN monitor.github_action_steps.created_at IS '监控记录创建时间';
COMMENT ON COLUMN monitor.github_action_steps.updated_at IS '监控记录更新时间';

CREATE INDEX IF NOT EXISTS idx_github_action_steps_run_id
  ON monitor.github_action_steps (run_id);
CREATE INDEX IF NOT EXISTS idx_github_action_steps_conclusion
  ON monitor.github_action_steps (conclusion);

CREATE TABLE IF NOT EXISTS monitor.github_action_failures (
  failure_key text PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES monitor.github_action_runs(run_id) ON DELETE CASCADE,
  job_id bigint REFERENCES monitor.github_action_jobs(job_id) ON DELETE SET NULL,
  step_number integer,
  failure_level text NOT NULL,
  monitor_environment text NOT NULL,
  workflow_name text,
  job_name text,
  step_name text,
  conclusion text,
  error_summary text NOT NULL,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE monitor.github_action_failures IS 'GitHub Actions 失败摘要表，供统计和 AI 失败归因使用';
COMMENT ON COLUMN monitor.github_action_failures.failure_key IS '失败记录幂等键，由 run_id、job_id、step_number 和失败层级生成';
COMMENT ON COLUMN monitor.github_action_failures.run_id IS '所属 GitHub Action Run ID';
COMMENT ON COLUMN monitor.github_action_failures.job_id IS '所属 GitHub Action Job ID，run 级失败可为空';
COMMENT ON COLUMN monitor.github_action_failures.step_number IS '失败 Step 序号，job/run 级失败可为空';
COMMENT ON COLUMN monitor.github_action_failures.failure_level IS '失败层级：run、job、step';
COMMENT ON COLUMN monitor.github_action_failures.monitor_environment IS '监控环境：dev 或 main，与所属 run 保持一致';
COMMENT ON COLUMN monitor.github_action_failures.workflow_name IS 'Workflow 名称冗余快照，便于失败分析';
COMMENT ON COLUMN monitor.github_action_failures.job_name IS 'Job 名称快照';
COMMENT ON COLUMN monitor.github_action_failures.step_name IS 'Step 名称快照';
COMMENT ON COLUMN monitor.github_action_failures.conclusion IS '失败结论';
COMMENT ON COLUMN monitor.github_action_failures.error_summary IS '失败摘要文本';
COMMENT ON COLUMN monitor.github_action_failures.context_json IS '失败上下文 JSON，用于未来 AI 分析扩展';
COMMENT ON COLUMN monitor.github_action_failures.created_at IS '失败记录创建时间';
COMMENT ON COLUMN monitor.github_action_failures.updated_at IS '失败记录更新时间';

CREATE INDEX IF NOT EXISTS idx_github_action_failures_run_id
  ON monitor.github_action_failures (run_id);
CREATE INDEX IF NOT EXISTS idx_github_action_failures_workflow_time
  ON monitor.github_action_failures (monitor_environment, workflow_name, created_at DESC);
