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

comment on database training_records is '训练记录系统归档数据库，用于保存每次解析运行记录、解析快照与结构化归档数据';

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

-- 8. 创建结构化日汇总表
create table if not exists archive.training_day (
  archived_date date primary key,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  total_activities integer not null default 0,
  total_duration_seconds integer not null default 0,
  training_calories integer null,
  workout_duration_minutes integer null,
  active_hours integer null,
  cycling_distance_km numeric(10, 2) null,
  intake_calories integer null,
  sleep_total_minutes integer null,
  night_sleep_minutes integer null,
  nap_minutes integer null,
  sleep_start_time text null,
  sleep_end_time text null,
  deep_sleep_minutes integer null,
  light_sleep_minutes integer null,
  rem_sleep_minutes integer null,
  awake_minutes integer null,
  measurement_count integer not null default 0,
  meal_count integer not null default 0,
  updated_at timestamptz not null
);

comment on table archive.training_day is '训练归档日汇总表，一天一行，供主查询和看板使用';

comment on column archive.training_day.archived_date is '归档日期';
comment on column archive.training_day.source_hash is '来源快照哈希';
comment on column archive.training_day.total_activities is '当天活动次数';
comment on column archive.training_day.total_duration_seconds is '当天活动总时长，单位秒';
comment on column archive.training_day.training_calories is '当天训练消耗热量';
comment on column archive.training_day.workout_duration_minutes is '当天锻炼总分钟数';
comment on column archive.training_day.active_hours is '当天活跃小时数';
comment on column archive.training_day.cycling_distance_km is '当天骑行总距离，单位公里';
comment on column archive.training_day.intake_calories is '当天饮食总热量';
comment on column archive.training_day.sleep_total_minutes is '当天总睡眠分钟数';
comment on column archive.training_day.night_sleep_minutes is '当天夜间睡眠分钟数';
comment on column archive.training_day.nap_minutes is '当天午睡分钟数';
comment on column archive.training_day.sleep_start_time is '当天睡眠开始时间';
comment on column archive.training_day.sleep_end_time is '当天睡眠结束时间';
comment on column archive.training_day.deep_sleep_minutes is '当天深睡分钟数';
comment on column archive.training_day.light_sleep_minutes is '当天浅睡分钟数';
comment on column archive.training_day.rem_sleep_minutes is '当天 REM 睡眠分钟数';
comment on column archive.training_day.awake_minutes is '当天清醒分钟数';
comment on column archive.training_day.measurement_count is '当天体测记录数';
comment on column archive.training_day.meal_count is '当天饮食条目数';
comment on column archive.training_day.updated_at is '该日汇总最近更新时间';

-- 9. 创建结构化睡眠明细表
create table if not exists archive.training_sleep (
  sleep_hash text primary key,
  archived_date date not null references archive.training_day(archived_date) on delete cascade,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  sleep_type text not null default '夜间睡眠',
  bedtime text null,
  wake_time text null,
  night_sleep_minutes integer null,
  total_sleep_minutes integer null,
  nap_minutes integer null,
  deep_sleep_minutes integer null,
  light_sleep_minutes integer null,
  rem_sleep_minutes integer null,
  awake_minutes integer null,
  sleep_stage_text text null,
  sleep_stage_detail jsonb null,
  sleep_score integer null,
  sleep_score_percentile integer null,
  deep_sleep_ratio_pct numeric(10, 2) null,
  light_sleep_ratio_pct numeric(10, 2) null,
  rem_sleep_ratio_pct numeric(10, 2) null,
  deep_sleep_continuity_score integer null,
  wake_count integer null,
  breathing_quality_score integer null,
  average_heart_rate_bpm integer null,
  hrv_ms integer null,
  average_spo2_pct numeric(10, 2) null,
  average_respiratory_rate numeric(10, 2) null,
  analysis_text text null,
  suggestion_text text null,
  updated_at timestamptz not null
);

comment on table archive.training_sleep is '训练睡眠明细表，一次睡眠记录一行';

comment on column archive.training_sleep.sleep_hash is '睡眠记录幂等哈希';
comment on column archive.training_sleep.archived_date is '归档日期';
comment on column archive.training_sleep.source_hash is '来源快照哈希';
comment on column archive.training_sleep.sleep_type is '睡眠类型，夜间睡眠或午睡';
comment on column archive.training_sleep.bedtime is '入睡时间文本';
comment on column archive.training_sleep.wake_time is '起床时间文本';
comment on column archive.training_sleep.night_sleep_minutes is '夜间睡眠分钟数';
comment on column archive.training_sleep.total_sleep_minutes is '总睡眠分钟数';
comment on column archive.training_sleep.nap_minutes is '午睡分钟数';
comment on column archive.training_sleep.deep_sleep_minutes is '深睡分钟数';
comment on column archive.training_sleep.light_sleep_minutes is '浅睡分钟数';
comment on column archive.training_sleep.rem_sleep_minutes is 'REM 睡眠分钟数';
comment on column archive.training_sleep.awake_minutes is '清醒分钟数';
comment on column archive.training_sleep.sleep_stage_text is '睡眠阶段文本';
comment on column archive.training_sleep.sleep_stage_detail is '睡眠阶段详情';
comment on column archive.training_sleep.sleep_score is '睡眠评分';
comment on column archive.training_sleep.sleep_score_percentile is '超过用户百分比';
comment on column archive.training_sleep.deep_sleep_ratio_pct is '深睡比例百分比';
comment on column archive.training_sleep.light_sleep_ratio_pct is '浅睡比例百分比';
comment on column archive.training_sleep.rem_sleep_ratio_pct is 'REM 比例百分比';
comment on column archive.training_sleep.deep_sleep_continuity_score is '深睡连续性评分';
comment on column archive.training_sleep.wake_count is '清醒次数';
comment on column archive.training_sleep.breathing_quality_score is '呼吸质量评分';
comment on column archive.training_sleep.average_heart_rate_bpm is '平均心率，单位次/分钟';
comment on column archive.training_sleep.hrv_ms is '平均心率变异性，单位毫秒';
comment on column archive.training_sleep.average_spo2_pct is '平均血氧饱和度百分比';
comment on column archive.training_sleep.average_respiratory_rate is '平均呼吸率，单位次/分钟';
comment on column archive.training_sleep.analysis_text is '睡眠解读文本';
comment on column archive.training_sleep.suggestion_text is '睡眠建议文本';
comment on column archive.training_sleep.updated_at is '该睡眠记录最近更新时间';

-- 10. 创建结构化活动明细表
create table if not exists archive.training_activity (
  activity_hash text primary key,
  archived_date date not null references archive.training_day(archived_date) on delete cascade,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  activity_time text null,
  activity_type text not null,
  raw_type text null,
  detail text null,
  calories integer null,
  heart_rate integer null,
  distance_km numeric(10, 2) null,
  avg_speed_kmh numeric(10, 2) null,
  duration_text text null,
  duration_seconds integer null,
  updated_at timestamptz not null
);

comment on table archive.training_activity is '训练活动明细表，一次活动一行';

comment on column archive.training_activity.activity_hash is '活动幂等哈希';
comment on column archive.training_activity.archived_date is '归档日期';
comment on column archive.training_activity.source_hash is '来源快照哈希';
comment on column archive.training_activity.activity_time is '活动时间文本';
comment on column archive.training_activity.activity_type is '标准化活动类型';
comment on column archive.training_activity.raw_type is '原始活动类型';
comment on column archive.training_activity.detail is '活动详情原文';
comment on column archive.training_activity.calories is '活动消耗热量';
comment on column archive.training_activity.heart_rate is '平均或记录心率';
comment on column archive.training_activity.distance_km is '活动距离，单位公里';
comment on column archive.training_activity.avg_speed_kmh is '平均速度，单位公里/小时';
comment on column archive.training_activity.duration_text is '活动时长文本';
comment on column archive.training_activity.duration_seconds is '活动时长秒数';
comment on column archive.training_activity.updated_at is '该活动最近更新时间';

create index if not exists idx_training_sleep_archived_date
on archive.training_sleep (archived_date);

comment on index archive.idx_training_sleep_archived_date is '按归档日期查询睡眠明细的索引';

create index if not exists idx_training_sleep_source_hash
on archive.training_sleep (source_hash);

comment on index archive.idx_training_sleep_source_hash is '按快照哈希查询对应睡眠明细的索引';

-- 11. 创建结构化体测表
create table if not exists archive.training_measurement (
  measurement_hash text primary key,
  archived_date date not null references archive.training_day(archived_date) on delete cascade,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  measured_at text null,
  weight_kg numeric(10, 3) null,
  bmi numeric(10, 2) null,
  body_fat_pct numeric(10, 2) null,
  skeletal_muscle_kg numeric(10, 3) null,
  body_water_pct numeric(10, 2) null,
  protein_pct numeric(10, 2) null,
  bone_mass_kg numeric(10, 3) null,
  visceral_fat_level numeric(10, 2) null,
  basal_metabolism_kcal integer null,
  body_age integer null,
  body_score integer null,
  body_type text null,
  fat_free_mass_kg numeric(10, 3) null,
  updated_at timestamptz not null
);

comment on table archive.training_measurement is '训练体测明细表，一次体测一行';

comment on column archive.training_measurement.measurement_hash is '体测幂等哈希';
comment on column archive.training_measurement.archived_date is '归档日期';
comment on column archive.training_measurement.source_hash is '来源快照哈希';
comment on column archive.training_measurement.measured_at is '体测时间文本';
comment on column archive.training_measurement.weight_kg is '体重，单位千克';
comment on column archive.training_measurement.bmi is 'BMI';
comment on column archive.training_measurement.body_fat_pct is '体脂率';
comment on column archive.training_measurement.skeletal_muscle_kg is '骨骼肌量，单位千克';
comment on column archive.training_measurement.body_water_pct is '身体水分率';
comment on column archive.training_measurement.protein_pct is '蛋白质率';
comment on column archive.training_measurement.bone_mass_kg is '骨量，单位千克';
comment on column archive.training_measurement.visceral_fat_level is '内脏脂肪等级';
comment on column archive.training_measurement.basal_metabolism_kcal is '基础代谢率，单位千卡';
comment on column archive.training_measurement.body_age is '身体年龄';
comment on column archive.training_measurement.body_score is '身体得分';
comment on column archive.training_measurement.body_type is '身体类型';
comment on column archive.training_measurement.fat_free_mass_kg is '去脂体重，单位千克';
comment on column archive.training_measurement.updated_at is '该体测最近更新时间';

-- 12. 创建结构化饮食明细表
create table if not exists archive.training_meal (
  meal_hash text primary key,
  archived_date date not null references archive.training_day(archived_date) on delete cascade,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  meal_name text not null,
  calories integer null,
  recommended_min integer null,
  recommended_max integer null,
  updated_at timestamptz not null
);

comment on table archive.training_meal is '训练饮食明细表，一餐一行';

comment on column archive.training_meal.meal_hash is '餐次幂等哈希';
comment on column archive.training_meal.archived_date is '归档日期';
comment on column archive.training_meal.source_hash is '来源快照哈希';
comment on column archive.training_meal.meal_name is '餐次名称';
comment on column archive.training_meal.calories is '该餐热量';
comment on column archive.training_meal.recommended_min is '建议最低热量';
comment on column archive.training_meal.recommended_max is '建议最高热量';
comment on column archive.training_meal.updated_at is '该餐最近更新时间';

-- 13. 创建每次运行留痕表
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

-- 14. 创建索引
create index if not exists idx_training_parse_run_finished_at
on archive.training_parse_run (run_finished_at desc);

comment on index archive.idx_training_parse_run_finished_at is '按运行结束时间倒序查询运行历史的索引';

create index if not exists idx_training_parse_run_source_hash
on archive.training_parse_run (source_hash);

comment on index archive.idx_training_parse_run_source_hash is '按快照哈希查询对应运行记录的索引';

create index if not exists idx_training_parse_run_trigger_finished_at
on archive.training_parse_run (trigger_name, run_finished_at desc);

comment on index archive.idx_training_parse_run_trigger_finished_at is '按触发来源和运行结束时间查询历史记录的索引';

create index if not exists idx_training_day_source_hash
on archive.training_day (source_hash);

comment on index archive.idx_training_day_source_hash is '按快照哈希查询对应日汇总的索引';

create index if not exists idx_training_activity_archived_date
on archive.training_activity (archived_date);

comment on index archive.idx_training_activity_archived_date is '按归档日期查询活动明细的索引';

create index if not exists idx_training_activity_type_date
on archive.training_activity (activity_type, archived_date desc);

comment on index archive.idx_training_activity_type_date is '按活动类型和日期查询活动明细的索引';

create index if not exists idx_training_measurement_archived_date
on archive.training_measurement (archived_date);

comment on index archive.idx_training_measurement_archived_date is '按归档日期查询体测明细的索引';

create index if not exists idx_training_meal_archived_date
on archive.training_meal (archived_date);

comment on index archive.idx_training_meal_archived_date is '按归档日期查询饮食明细的索引';

-- 15. 赋权
grant usage on schema archive to training_writer;
grant select, insert, update, delete on all tables in schema archive to training_writer;
grant usage, select on all sequences in schema archive to training_writer;

alter default privileges in schema archive
grant select, insert, update, delete on tables to training_writer;

alter default privileges in schema archive
grant usage, select on sequences to training_writer;

-- 16. 创建 ingest schema
create schema if not exists ingest authorization training_writer;

comment on schema ingest is 'Telegram 等外部输入的原始接入与识别留痕';

create table if not exists ingest.telegram_batch (
  batch_id text primary key,
  status text not null,
  archived_date date null,
  reason text null,
  confidence numeric(10, 4) null,
  warnings_json jsonb not null default '[]'::jsonb,
  issues_json jsonb not null default '[]'::jsonb,
  update_ids_json jsonb not null default '[]'::jsonb,
  payload_hash text not null,
  batch_payload_json jsonb not null,
  processed_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists ingest.telegram_message (
  message_id bigint primary key,
  batch_id text not null references ingest.telegram_batch(batch_id) on delete cascade,
  update_id bigint not null,
  media_group_id text null,
  chat_id bigint null,
  caption text null,
  text text null,
  date_unix bigint null,
  photo_file_ids_json jsonb not null default '[]'::jsonb,
  photo_file_unique_ids_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null
);

create table if not exists ingest.telegram_recognition (
  message_id bigint primary key references ingest.telegram_message(message_id) on delete cascade,
  batch_id text not null references ingest.telegram_batch(batch_id) on delete cascade,
  recognition_json jsonb not null,
  updated_at timestamptz not null
);

create index if not exists idx_ingest_telegram_message_update_id
on ingest.telegram_message (update_id desc);


-- Telegram 识别失败待重试批次表
create sequence if not exists ingest.telegram_pending_batch_pending_id_seq;

create table if not exists ingest.telegram_pending_batch (
  pending_id bigint primary key default nextval('ingest.telegram_pending_batch_pending_id_seq'),
  batch_id text not null unique,
  kind text not null default 'image',
  status text not null default 'pending',
  batch_payload_json jsonb not null,
  failure_category text null,
  failure_reason text null,
  attempt_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  resolved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table ingest.telegram_pending_batch is 'Telegram 同步待重试批次表，用于保存 AI 识别失败但不能丢弃的图片批次';

comment on column ingest.telegram_pending_batch.pending_id is '待重试记录自增主键';
comment on column ingest.telegram_pending_batch.batch_id is 'Telegram 批次 ID，单图为 single-messageId，相册为 media_group_id';
comment on column ingest.telegram_pending_batch.kind is '批次类型，当前主要为 image';
comment on column ingest.telegram_pending_batch.status is '重试状态：pending 待重试，resolved 已成功处理，abandoned 放弃处理';
comment on column ingest.telegram_pending_batch.batch_payload_json is '完整批次 payload，包含 messageId、updateId、chatId、photo file_id 等重放所需数据';
comment on column ingest.telegram_pending_batch.failure_category is '最近一次失败分类，例如 ai_service、telegram_api、system_bug';
comment on column ingest.telegram_pending_batch.failure_reason is '最近一次失败原因摘要';
comment on column ingest.telegram_pending_batch.attempt_count is '已重试次数';
comment on column ingest.telegram_pending_batch.next_retry_at is '下次允许重试时间';
comment on column ingest.telegram_pending_batch.last_failed_at is '最近一次失败时间';
comment on column ingest.telegram_pending_batch.resolved_at is '成功处理或人工关闭时间';
comment on column ingest.telegram_pending_batch.created_at is '记录创建时间';
comment on column ingest.telegram_pending_batch.updated_at is '记录更新时间';

create index if not exists idx_ingest_telegram_pending_batch_status_retry
on ingest.telegram_pending_batch (status, next_retry_at);

create index if not exists idx_ingest_telegram_pending_batch_updated_at
on ingest.telegram_pending_batch (updated_at desc);
-- 17. 创建 core schema
create schema if not exists core authorization training_writer;

comment on schema core is '训练记录系统业务主数据层';

create table if not exists core.training_day (
  archived_date date primary key,
  source_channel text not null,
  source_batch_id text null,
  total_activities integer not null default 0,
  total_duration_seconds integer not null default 0,
  training_calories numeric(10, 2) not null default 0,
  workout_duration_minutes integer null,
  active_hours integer null,
  cycling_distance_km numeric(10, 2) null,
  intake_calories integer null,
  sleep_total_minutes integer null,
  night_sleep_minutes integer null,
  nap_minutes integer null,
  sleep_start_time text null,
  sleep_end_time text null,
  deep_sleep_minutes integer null,
  light_sleep_minutes integer null,
  rem_sleep_minutes integer null,
  awake_minutes integer null,
  nutrition_details_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null
);

create table if not exists core.measurement (
  measurement_key text primary key,
  archived_date date not null references core.training_day(archived_date) on delete cascade,
  source_channel text not null,
  source_batch_id text null,
  measured_at text null,
  body_score integer null,
  weight_kg numeric(10, 3) null,
  bmi numeric(10, 2) null,
  body_fat_pct numeric(10, 2) null,
  skeletal_muscle_kg numeric(10, 3) null,
  visceral_fat_level numeric(10, 2) null,
  basal_metabolism_kcal integer null,
  body_water_pct numeric(10, 2) null,
  protein_pct numeric(10, 2) null,
  bone_mass_kg numeric(10, 3) null,
  fat_free_mass_kg numeric(10, 3) null,
  body_age integer null,
  body_type text null,
  updated_at timestamptz not null
);

create table if not exists core.sleep (
  sleep_key text primary key,
  archived_date date not null references core.training_day(archived_date) on delete cascade,
  source_channel text not null,
  source_batch_id text null,
  sleep_type text not null default '夜间睡眠',
  bedtime text null,
  wake_time text null,
  night_sleep_minutes integer null,
  total_sleep_minutes integer null,
  nap_minutes integer null,
  deep_sleep_minutes integer null,
  light_sleep_minutes integer null,
  rem_sleep_minutes integer null,
  awake_minutes integer null,
  sleep_stage_text text null,
  sleep_stage_detail text null,
  sleep_score integer null,
  sleep_score_percentile integer null,
  deep_sleep_ratio_pct numeric(10, 2) null,
  light_sleep_ratio_pct numeric(10, 2) null,
  rem_sleep_ratio_pct numeric(10, 2) null,
  deep_sleep_continuity_score integer null,
  wake_count integer null,
  breathing_quality_score integer null,
  average_heart_rate_bpm integer null,
  hrv_ms integer null,
  average_spo2_pct numeric(10, 2) null,
  average_respiratory_rate numeric(10, 2) null,
  analysis_text text null,
  suggestion_text text null,
  updated_at timestamptz not null
);

create table if not exists core.activity (
  activity_key text primary key,
  archived_date date not null references core.training_day(archived_date) on delete cascade,
  source_channel text not null,
  source_batch_id text null,
  activity_time text null,
  activity_type text not null,
  raw_type text null,
  detail text null,
  calories integer null,
  heart_rate integer null,
  distance_km numeric(10, 2) null,
  avg_speed_kmh numeric(10, 2) null,
  duration_text text null,
  duration_seconds integer null,
  updated_at timestamptz not null
);

create table if not exists core.meal (
  meal_key text primary key,
  archived_date date not null references core.training_day(archived_date) on delete cascade,
  source_channel text not null,
  source_batch_id text null,
  meal_name text not null,
  calories integer null,
  recommended_min integer null,
  recommended_max integer null,
  updated_at timestamptz not null
);

create table if not exists core.thought (
  telegram_message_id bigint primary key,
  telegram_chat_id bigint null,
  source_batch_id text null,
  source_channel text null,
  command text not null,
  body text not null,
  thought_module text not null default 'workout',
  tags_json jsonb not null default '["训练","随想","Telegram"]'::jsonb,
  message_date_unix bigint null,
  markdown_path text null,
  image_refs_json jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  deleted_at timestamptz null,
  updated_at timestamptz not null
);

-- Idempotent column additions for tables created before schema evolution
alter table core.sleep add column if not exists total_sleep_minutes integer null;
alter table core.sleep add column if not exists sleep_score integer null;
alter table core.sleep add column if not exists sleep_score_percentile integer null;
alter table core.sleep add column if not exists deep_sleep_continuity_score integer null;
alter table core.sleep add column if not exists wake_count integer null;
alter table core.sleep add column if not exists breathing_quality_score integer null;
alter table core.sleep add column if not exists average_heart_rate_bpm integer null;
alter table core.sleep add column if not exists hrv_ms integer null;
alter table core.sleep add column if not exists average_spo2_pct numeric(10, 2) null;
alter table core.sleep add column if not exists average_respiratory_rate numeric(10, 2) null;
alter table core.sleep add column if not exists analysis_text text null;
alter table core.sleep add column if not exists suggestion_text text null;

alter table core.training_day add column if not exists sleep_total_minutes integer null;
alter table core.training_day add column if not exists night_sleep_minutes integer null;
alter table core.training_day add column if not exists nap_minutes integer null;
alter table core.training_day add column if not exists sleep_start_time text null;
alter table core.training_day add column if not exists sleep_end_time text null;
alter table core.training_day add column if not exists deep_sleep_minutes integer null;
alter table core.training_day add column if not exists light_sleep_minutes integer null;
alter table core.training_day add column if not exists rem_sleep_minutes integer null;
alter table core.training_day add column if not exists awake_minutes integer null;

comment on table core.thought is '锻炼随想正文镜像表；图片仍保存在本地目录或后续对象存储，表内只保存引用';
comment on column core.thought.telegram_message_id is '原 Telegram message_id，也是随想的稳定定位 ID';
comment on column core.thought.source_channel is '来源通道，例如 telegram、feishu、markdown_import';
comment on column core.thought.body is '随想正文文本，不包含图片二进制';
comment on column core.thought.thought_module is '随想模块：workout 为锻炼随想，misc 为杂七杂八，body_feedback 为身体反馈；历史缺省按 workout 兼容';
comment on column core.thought.markdown_path is '当前 Markdown 兼容层路径，例如 source/_posts/YYYY-MM-DD-telegram-thought-501.md';
comment on column core.thought.image_refs_json is '有序图片引用清单，当前为 /images/thoughts/...，后续可切换为 OSS object key 或 URL';
comment on column core.thought.status is 'active 或 deleted；删除命令使用软删除保留迁移线索';

create index if not exists idx_core_measurement_archived_date
on core.measurement (archived_date);

create index if not exists idx_core_sleep_archived_date
on core.sleep (archived_date);

create index if not exists idx_core_activity_archived_date
on core.activity (archived_date);

create index if not exists idx_core_meal_archived_date
on core.meal (archived_date);

create index if not exists idx_core_thought_updated_at
on core.thought (updated_at desc);

create index if not exists idx_core_thought_module_updated_at
on core.thought (thought_module, updated_at desc);

grant usage on schema ingest to training_writer;
grant usage on schema core to training_writer;
grant select, insert, update, delete on all tables in schema ingest to training_writer;
grant select, insert, update, delete on all tables in schema core to training_writer;

alter default privileges in schema ingest
grant select, insert, update, delete on tables to training_writer;

alter default privileges in schema core
grant select, insert, update, delete on tables to training_writer;
