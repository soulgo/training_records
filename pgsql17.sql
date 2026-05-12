- 建议先使用超级用户或具备建库/建角色权限的管理员账号执行

-- 登录：psql -U postgres -d postgres -p15432
-- 1. 创建业务写入用户
create role training_writer
login
password '请替换为强密码';

comment on role training_writer is '训练解析归档写入专用用户，仅用于训练记录解析结果旁路写库';

-- 2. 创建数据库
create database training_records
owner training_writer
encoding 'UTF8'
template template0;

comment on database training_records is '训练记录系统归档数据库，用于保存每次解析运行记录与解析快照';

-- 3. 连接到目标数据库后继续执行
-- \c training_records

-- 4. 创建 schema
create schema if not exists archive authorization training_writer;

comment on schema archive is '训练记录解析归档专用 schema';

-- 5. 可选：限制 public schema 默认权限
revoke create on schema public from public;

-- 6. 启用扩展
-- create extension if not exists pgcrypto;

-- comment on extension pgcrypto is '提供摘要计算等能力，供归档系统扩展使用';

-- 7. 创建解析快照表
create table if not exists archive.training_parse_snapshot (
  source_hash text primary key,
  payload_version integer not null default 1,
  payload_json jsonb not null,
  daily_count integer not null,
  latest_archived_date date null,
  parsed_generated_at timestamptz not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);

comment on table archive.training_parse_snapshot is '训练记录解析快照表，按训练记录原文哈希去重保存完整解析结果';

comment on column archive.training_parse_snapshot.source_hash is '训练记录Markdown原文的SHA-256哈希，作为快照主键';
comment on column archive.training_parse_snapshot.payload_version is '解析结果结构版本号，便于后续结构升级兼容';
comment on column archive.training_parse_snapshot.payload_json is '完整解析结果JSON，内容对应当前parseTrainingRecord输出';
comment on column archive.training_parse_snapshot.daily_count is '本次解析出的日期记录总数';
comment on column archive.training_parse_snapshot.latest_archived_date is '本次解析结果中最新的归档日期';
comment on column archive.training_parse_snapshot.parsed_generated_at is '解析结果中的generatedAt时间';
comment on column archive.training_parse_snapshot.first_seen_at is '该快照首次入库时间';
comment on column archive.training_parse_snapshot.last_seen_at is '该快照最近一次被再次观察到的时间';

-- 8. 创建每次运行留痕表
create table if not exists archive.training_parse_run (
  run_id uuid primary key,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  trigger_name text not null,
  actor_name text null,
  runtime_env text not null,
  run_started_at timestamptz not null,
  run_finished_at timestamptz not null,
  daily_count integer not null,
  latest_archived_date date null,
  main_output_written boolean not null default true,
  db_sync_status text not null default 'success'
);

comment on table archive.training_parse_run is '训练记录解析运行留痕表，每次执行构建都会新增一条记录';

comment on column archive.training_parse_run.run_id is '本次运行唯一标识UUID';
comment on column archive.training_parse_run.source_hash is '关联的训练记录原文哈希，对应快照表主键';
comment on column archive.training_parse_run.trigger_name is '触发来源，例如local-build-data、local-build、github-actions-build';
comment on column archive.training_parse_run.actor_name is '触发执行人，本地为系统用户名，CI为GitHub Actor';
comment on column archive.training_parse_run.runtime_env is '运行环境标识，例如local或github-actions';
comment on column archive.training_parse_run.run_started_at is '本次构建开始时间';
comment on column archive.training_parse_run.run_finished_at is '本次构建结束时间';
comment on column archive.training_parse_run.daily_count is '本次运行解析出的日期记录总数';
comment on column archive.training_parse_run.latest_archived_date is '本次运行解析结果中最新的归档日期';
comment on column archive.training_parse_run.main_output_written is '主输出文件training.json和调试Markdown是否已成功写出';
comment on column archive.training_parse_run.db_sync_status is '数据库归档状态，当前成功写入固定为success，预留后续扩展';

-- 9. 创建索引
create index if not exists idx_training_parse_run_finished_at
on archive.training_parse_run (run_finished_at desc);

comment on index archive.idx_training_parse_run_finished_at is '按运行结束时间倒序查询运行历史的索引';

create index if not exists idx_training_parse_run_source_hash
on archive.training_parse_run (source_hash);

comment on index archive.idx_training_parse_run_source_hash is '按快照哈希查询对应运行记录的索引';

create index if not exists idx_training_parse_run_trigger_finished_at
on archive.training_parse_run (trigger_name, run_finished_at desc);

comment on index archive.idx_training_parse_run_trigger_finished_at is '按触发来源和运行结束时间查询历史记录的索引';

-- 10. 赋权
grant usage on schema archive to training_writer;
grant select, insert, update, delete on all tables in schema archive to training_writer;
grant usage, select on all sequences in schema archive to training_writer;

alter default privileges in schema archive
grant select, insert, update, delete on tables to training_writer;

alter default privileges in schema archive
grant usage, select on sequences to training_writer;