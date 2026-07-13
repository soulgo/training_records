-- 目的：为 dev 数据库补充 /分析 依赖的训练者画像表。
-- 执行方式：使用 training_writer 或具备 DDL 权限的数据库管理员手工执行。
-- 账号边界：写账号固定为 training_writer；只读账号名来自 GitHub Settings 中的连接 URL，不在 SQL 中硬编码。
-- 安全性：整个更新位于单一事务中；前置检查或 DDL 失败时不会留下半成品。

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regnamespace('core') is null then
    raise exception 'required schema core does not exist';
  end if;

  if to_regrole('training_writer') is null then
    raise exception 'required database role training_writer does not exist';
  end if;

  if to_regclass('core.training_day') is null then
    raise exception 'required reference table core.training_day does not exist';
  end if;
end
$preflight$;

create table if not exists core.trainee_profile (
  trainee_id text primary key,
  timezone text not null default 'Asia/Shanghai',
  birth_date date,
  sex_at_birth text,
  height_cm numeric(5,2),
  experience_level text,
  goal_text text not null default '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。',
  weekly_training_days_target smallint,
  profile_json jsonb not null default jsonb_build_object(
    'availableEquipment', '[]'::jsonb,
    'chronicLimitations', '[]'::jsonb,
    'preferredActivities', '[]'::jsonb,
    'scheduleNotes', null
  ),
  profile_version integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_trainee_profile_id check (btrim(trainee_id) <> ''),
  constraint ck_trainee_profile_timezone check (btrim(timezone) <> ''),
  constraint ck_trainee_profile_birth_date check (
    birth_date is null or birth_date >= date '1900-01-01'
  ),
  constraint ck_trainee_profile_sex_at_birth check (
    sex_at_birth is null or sex_at_birth in ('female', 'male', 'intersex', 'undisclosed')
  ),
  constraint ck_trainee_profile_height check (
    height_cm is null or height_cm between 80 and 250
  ),
  constraint ck_trainee_profile_experience check (
    experience_level is null or experience_level in ('beginner', 'intermediate', 'advanced', 'unknown')
  ),
  constraint ck_trainee_profile_goal check (btrim(goal_text) <> ''),
  constraint ck_trainee_profile_weekly_days check (
    weekly_training_days_target is null or weekly_training_days_target between 1 and 7
  ),
  constraint ck_trainee_profile_json_object check (
    jsonb_typeof(profile_json) = 'object'
  ),
  constraint ck_trainee_profile_equipment_array check (
    not (profile_json ? 'availableEquipment')
    or jsonb_typeof(profile_json->'availableEquipment') = 'array'
  ),
  constraint ck_trainee_profile_limitations_array check (
    not (profile_json ? 'chronicLimitations')
    or jsonb_typeof(profile_json->'chronicLimitations') = 'array'
  ),
  constraint ck_trainee_profile_activities_array check (
    not (profile_json ? 'preferredActivities')
    or jsonb_typeof(profile_json->'preferredActivities') = 'array'
  ),
  constraint ck_trainee_profile_schedule_notes check (
    not (profile_json ? 'scheduleNotes')
    or profile_json->'scheduleNotes' = 'null'::jsonb
    or jsonb_typeof(profile_json->'scheduleNotes') = 'string'
  ),
  constraint ck_trainee_profile_version check (profile_version >= 1)
);

alter table core.trainee_profile owner to training_writer;

comment on table core.trainee_profile is
  '训练者稳定画像；供训练分析限定目标、经验、长期限制与可用器械，不复制动态训练和健康事实';
comment on column core.trainee_profile.trainee_id is
  '系统内训练者身份；当前单用户使用 default，保留未来多训练者扩展能力';
comment on column core.trainee_profile.timezone is
  '训练者 IANA 时区，用于日期窗口和年龄计算';
comment on column core.trainee_profile.birth_date is
  '出生日期；年龄在分析时计算，不存储 age';
comment on column core.trainee_profile.sex_at_birth is
  '可选生理性别输入，仅在确有运动科学计算需要时使用；undisclosed 表示不提供';
comment on column core.trainee_profile.height_cm is
  '身高厘米；用于需要身高的派生指标，不复制体测表中的动态数据';
comment on column core.trainee_profile.experience_level is
  '训练经验等级：beginner、intermediate、advanced 或 unknown';
comment on column core.trainee_profile.goal_text is
  '训练者当前长期目标原文，直接进入分析上下文，不由后端猜测';
comment on column core.trainee_profile.weekly_training_days_target is
  '用户期望的每周训练天数；为空表示不设置硬目标';
comment on column core.trainee_profile.profile_json is
  '不参与主查询的可演进画像配置：可用器械、长期限制、偏好活动和日程说明';
comment on column core.trainee_profile.profile_version is
  '画像乐观更新版本；每次业务更新递增，用于分析上下文审计';
comment on column core.trainee_profile.is_active is
  '是否为可用于分析的有效画像';

insert into core.trainee_profile (
  trainee_id,
  timezone,
  goal_text,
  experience_level,
  profile_json
)
values (
  'default',
  'Asia/Shanghai',
  '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。',
  'unknown',
  jsonb_build_object(
    'availableEquipment', '[]'::jsonb,
    'chronicLimitations', '[]'::jsonb,
    'preferredActivities', '[]'::jsonb,
    'scheduleNotes', null
  )
)
on conflict (trainee_id) do nothing;

-- 复用现有事实表的只读授权。GitHub Settings 中的只读连接账号只要已经能读取
-- core.training_day，就会自动获得 core.trainee_profile 的 SELECT 权限；账号名无需写入仓库。
do $inherit_read_grants$
declare
  reader record;
begin
  for reader in
    select distinct grantee
    from information_schema.table_privileges
    where table_schema = 'core'
      and table_name = 'training_day'
      and privilege_type = 'SELECT'
      and grantee <> 'training_writer'
  loop
    if reader.grantee = 'PUBLIC' then
      execute 'grant select on core.trainee_profile to public';
    else
      execute format('grant select on core.trainee_profile to %I', reader.grantee);
    end if;
  end loop;
end
$inherit_read_grants$;

commit;

-- 验收结果 1：应返回 core.trainee_profile。
select to_regclass('core.trainee_profile') as trainee_profile;

-- 验收结果 2：应返回 default、Asia/Shanghai、unknown、1、true。
select
  trainee_id,
  timezone,
  experience_level,
  profile_version,
  is_active
from core.trainee_profile
where trainee_id = 'default';

-- 验收结果 3：owner 应为 training_writer，writer_can_manage 应为 true。
select
  tableowner as owner,
  has_table_privilege('training_writer', 'core.trainee_profile', 'SELECT')
    and has_table_privilege('training_writer', 'core.trainee_profile', 'INSERT')
    and has_table_privilege('training_writer', 'core.trainee_profile', 'UPDATE')
    and has_table_privilege('training_writer', 'core.trainee_profile', 'DELETE') as writer_can_manage
from pg_tables
where schemaname = 'core'
  and tablename = 'trainee_profile';

-- 验收结果 4：应列出与 core.training_day 相同的显式 SELECT grantee。
-- 如果 GitHub Settings 中的 dev 只读账号通过组角色授权，这里显示对应组角色。
select grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'core'
  and table_name = 'trainee_profile'
  and privilege_type = 'SELECT'
order by grantee;
