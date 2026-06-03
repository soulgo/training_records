-- ------------------------------------------------------------
-- 训练睡眠数据结构补充脚本
-- 适用于 training_records.archive schema
-- 用途：新增睡眠明细表，并为 training_day 追加睡眠汇总字段
-- ------------------------------------------------------------

-- 1. 睡眠明细表
create table if not exists archive.training_sleep (
  sleep_hash text primary key,
  archived_date date not null references archive.training_day(archived_date) on delete cascade,
  source_hash text not null references archive.training_parse_snapshot(source_hash),
  sleep_type text not null,
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
  updated_at timestamptz not null
);

comment on table archive.training_sleep is '训练睡眠明细表，一条睡眠记录一行，用于保存夜间睡眠、午睡及睡眠阶段信息';

comment on column archive.training_sleep.sleep_hash is '睡眠记录幂等哈希，用于去重';
comment on column archive.training_sleep.archived_date is '归档日期';
comment on column archive.training_sleep.source_hash is '来源快照哈希';
comment on column archive.training_sleep.sleep_type is '睡眠类型，例如夜间睡眠、午睡、小睡';
comment on column archive.training_sleep.bedtime is '入睡时间文本，例如23:10';
comment on column archive.training_sleep.wake_time is '起床时间文本，例如05:46';
comment on column archive.training_sleep.night_sleep_minutes is '夜间睡眠时长，单位分钟';
comment on column archive.training_sleep.total_sleep_minutes is '总睡眠时长，单位分钟';
comment on column archive.training_sleep.nap_minutes is '午睡或零星小睡时长，单位分钟';
comment on column archive.training_sleep.deep_sleep_minutes is '深睡时长，单位分钟';
comment on column archive.training_sleep.light_sleep_minutes is '浅睡时长，单位分钟';
comment on column archive.training_sleep.rem_sleep_minutes is '快速眼动睡眠时长，单位分钟';
comment on column archive.training_sleep.awake_minutes is '清醒时长，单位分钟';
comment on column archive.training_sleep.sleep_stage_text is '睡眠阶段的原始文本描述';
comment on column archive.training_sleep.sleep_stage_detail is '睡眠阶段结构化详情JSON';
comment on column archive.training_sleep.updated_at is '该睡眠记录最近更新时间';

create index if not exists idx_training_sleep_archived_date
on archive.training_sleep (archived_date);

comment on index archive.idx_training_sleep_archived_date is '按归档日期查询睡眠记录的索引';

create index if not exists idx_training_sleep_source_hash
on archive.training_sleep (source_hash);

comment on index archive.idx_training_sleep_source_hash is '按快照哈希查询对应睡眠记录的索引';

create index if not exists idx_training_sleep_type_date
on archive.training_sleep (sleep_type, archived_date desc);

comment on index archive.idx_training_sleep_type_date is '按睡眠类型和日期查询睡眠记录的索引';

-- 2. 日汇总表追加睡眠字段
alter table archive.training_day
add column if not exists sleep_total_minutes integer null,
add column if not exists night_sleep_minutes integer null,
add column if not exists nap_minutes integer null,
add column if not exists sleep_start_time text null,
add column if not exists sleep_end_time text null,
add column if not exists deep_sleep_minutes integer null,
add column if not exists light_sleep_minutes integer null,
add column if not exists rem_sleep_minutes integer null,
add column if not exists awake_minutes integer null;

comment on column archive.training_day.sleep_total_minutes is '当天总睡眠时长，单位分钟';
comment on column archive.training_day.night_sleep_minutes is '当天夜间睡眠时长，单位分钟';
comment on column archive.training_day.nap_minutes is '当天午睡或零星小睡时长，单位分钟';
comment on column archive.training_day.sleep_start_time is '当天入睡时间文本';
comment on column archive.training_day.sleep_end_time is '当天起床时间文本';
comment on column archive.training_day.deep_sleep_minutes is '当天深睡时长，单位分钟';
comment on column archive.training_day.light_sleep_minutes is '当天浅睡时长，单位分钟';
comment on column archive.training_day.rem_sleep_minutes is '当天快速眼动睡眠时长，单位分钟';
comment on column archive.training_day.awake_minutes is '当天清醒时长，单位分钟';
