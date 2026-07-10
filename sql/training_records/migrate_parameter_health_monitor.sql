-- 系统参数健康检查迁移
--
-- 使用方式：在 dev 与 main 对应的 training_records 数据库中分别手工执行一次。
-- 本脚本不删除表、不清空历史，可重复执行。执行前仍建议先备份 monitor schema。

begin;

alter table monitor.system_config_parameters
  add column if not exists health_probe_key text;

alter table monitor.system_config_parameters
  add column if not exists health_check_type text;

update monitor.system_config_parameters
set
  health_probe_key = coalesce(nullif(health_probe_key, ''), 'legacy_unconfigured'),
  health_check_type = coalesce(nullif(health_check_type, ''), 'unsupported');

alter table monitor.system_config_parameters
  alter column health_probe_key set default 'legacy_unconfigured',
  alter column health_probe_key set not null,
  alter column health_check_type set default 'unsupported',
  alter column health_check_type set not null;

comment on column monitor.system_config_parameters.health_probe_key is
  '参数引用的健康探测定义 key；探测定义本身维护在 config/parameter-health/<env>.json，不保存凭证值';
comment on column monitor.system_config_parameters.health_check_type is
  '健康探测类型，例如 postgres_connect、openai_models、telegram_get_me、presence、unsupported';
comment on column monitor.system_config_parameters.validity_mode is
  '可选到期信息来源模式；不再用于推断参数当前健康状态';
comment on table monitor.system_config_parameters is
  '系统配置参数健康主表，记录参数身份、探测方式和可选到期元数据，不保存参数值';

alter table monitor.system_config_parameter_checks
  add column if not exists check_type text;

alter table monitor.system_config_parameter_checks
  add column if not exists latency_ms int4;

alter table monitor.system_config_parameter_checks
  add column if not exists failure_kind text;

alter table monitor.system_config_parameter_checks
  add column if not exists observed_expires_at timestamptz(6);

-- 旧的 ok/warning/expired 仅来自日期推算，不属于真实健康证据。
-- 将原值保存在 details_json.legacy_status 后降为 unknown。
update monitor.system_config_parameter_checks
set
  details_json = coalesce(details_json, '{}'::jsonb)
    || jsonb_build_object('legacy_status', status),
  status = 'unknown',
  check_type = coalesce(nullif(check_type, ''), 'legacy_validity'),
  failure_kind = coalesce(nullif(failure_kind, ''), 'legacy_validity_only'),
  message = '历史记录仅有日期推算，没有真实健康探测证据'
where status not in ('healthy', 'present', 'invalid', 'missing', 'not_configured', 'unreachable', 'unsupported', 'unknown');

update monitor.system_config_parameter_checks
set check_type = coalesce(nullif(check_type, ''), 'legacy_validity')
where check_type is null or check_type = '';

alter table monitor.system_config_parameter_checks
  alter column check_type set default 'legacy_validity',
  alter column check_type set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ck_system_config_parameter_checks_health_status'
      and conrelid = 'monitor.system_config_parameter_checks'::regclass
  ) then
    alter table monitor.system_config_parameter_checks
      add constraint ck_system_config_parameter_checks_health_status
      check (status in ('healthy', 'present', 'invalid', 'missing', 'not_configured', 'unreachable', 'unsupported', 'unknown'))
      not valid;
  end if;
end
$$;

alter table monitor.system_config_parameter_checks
  validate constraint ck_system_config_parameter_checks_health_status;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ck_system_config_parameter_checks_latency_nonnegative'
      and conrelid = 'monitor.system_config_parameter_checks'::regclass
  ) then
    alter table monitor.system_config_parameter_checks
      add constraint ck_system_config_parameter_checks_latency_nonnegative
      check (latency_ms is null or latency_ms >= 0)
      not valid;
  end if;
end
$$;

alter table monitor.system_config_parameter_checks
  validate constraint ck_system_config_parameter_checks_latency_nonnegative;

create index if not exists idx_system_config_parameter_checks_last_healthy
  on monitor.system_config_parameter_checks (parameter_key, checked_at desc)
  where status = 'healthy';

comment on column monitor.system_config_parameter_checks.status is
  '健康状态：healthy、present、invalid、missing、not_configured、unreachable、unsupported、unknown';
comment on column monitor.system_config_parameter_checks.check_type is
  '本次实际使用的健康探测类型';
comment on column monitor.system_config_parameter_checks.latency_ms is
  '健康探测耗时毫秒数；未执行主动探测时可为空或为 0';
comment on column monitor.system_config_parameter_checks.failure_kind is
  '失败分类，例如 authentication、timeout、network、provider_error、credential_missing、no_safe_probe';
comment on column monitor.system_config_parameter_checks.observed_expires_at is
  'Provider 本次明确返回的真实到期时间；Provider 未提供时为空';
comment on column monitor.system_config_parameter_checks.days_until_due is
  '仅在存在 registered/provider expiry 时计算的剩余天数；不参与当前健康状态判定';
comment on column monitor.system_config_parameter_checks.details_json is
  '非敏感探测细节，例如 HTTP 状态、Provider 状态、expiryStatus；禁止保存凭证值、URL 或 token';
comment on table monitor.system_config_parameter_checks is
  '系统配置参数健康检查历史，记录真实探测、存在性检查或不支持原因';

commit;
