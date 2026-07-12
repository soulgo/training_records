export class PostgresParameterHealthMonitorRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresParameterHealthMonitorRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async writeParameterAudit({ parameters = [], checks = [] } = {}) {
    await this.client.query('begin');
    try {
      for (const parameter of parameters) {
        await this.upsertParameter(parameter);
      }
      for (const check of checks) {
        await this.insertParameterCheck(check);
      }
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback');
      throw error;
    }
  }

  async upsertParameter(parameter) {
    await this.client.query(
      `
        insert into monitor.system_config_parameters (
          parameter_key, monitor_environment, parameter_name, scope, category,
          required, sensitive, health_probe_key, health_check_type, validity_mode,
          valid_from, expires_at, review_after_at, rotation_cycle_days,
          warning_days, critical_days, owner, source_doc, source_code_json,
          metadata_json, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb,
          $20::jsonb, now()
        )
        on conflict (parameter_key) do update set
          monitor_environment = excluded.monitor_environment,
          parameter_name = excluded.parameter_name,
          scope = excluded.scope,
          category = excluded.category,
          required = excluded.required,
          sensitive = excluded.sensitive,
          health_probe_key = excluded.health_probe_key,
          health_check_type = excluded.health_check_type,
          validity_mode = excluded.validity_mode,
          valid_from = excluded.valid_from,
          expires_at = excluded.expires_at,
          review_after_at = excluded.review_after_at,
          rotation_cycle_days = excluded.rotation_cycle_days,
          warning_days = excluded.warning_days,
          critical_days = excluded.critical_days,
          owner = excluded.owner,
          source_doc = excluded.source_doc,
          source_code_json = excluded.source_code_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      [
        parameter.key,
        parameter.environment,
        parameter.name,
        parameter.scope,
        parameter.category,
        Boolean(parameter.required),
        Boolean(parameter.sensitive),
        parameter.healthProbeKey,
        parameter.healthCheckType,
        parameter.validityMode,
        parameter.validFrom ?? null,
        parameter.expiresAt ?? null,
        parameter.reviewAfterAt ?? null,
        parameter.rotationCycleDays ?? null,
        parameter.warningDays ?? 30,
        parameter.criticalDays ?? 7,
        parameter.owner ?? null,
        parameter.sourceDoc ?? null,
        JSON.stringify(parameter.sourceCode ?? []),
        JSON.stringify(parameter.metadata ?? {}),
      ],
    );
  }

  async insertParameterCheck(check) {
    await this.client.query(
      `
        insert into monitor.system_config_parameter_checks (
          parameter_key, monitor_environment, run_id, checked_at, status,
          check_type, latency_ms, failure_kind, observed_expires_at,
          days_until_due, evidence_source, message, details_json
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13::jsonb
        )
      `,
      [
        check.parameterKey,
        check.environment,
        check.runId ?? null,
        check.checkedAt ?? new Date().toISOString(),
        check.status,
        check.checkType,
        check.latencyMs ?? null,
        check.failureKind ?? null,
        check.observedExpiresAt ?? null,
        check.daysUntilDue ?? null,
        check.evidenceSource,
        check.message ?? null,
        JSON.stringify(check.details ?? {}),
      ],
    );
  }

  async listLatestParameterChecks(options = {}) {
    const monitorEnvironment = normalizeNullableText(options.monitorEnvironment);
    const limit = normalizeLimit(options.limit);
    const result = await this.client.query(
      buildLatestParameterChecksQuery({ hasLimit: Boolean(limit) }),
      limit ? [monitorEnvironment, limit] : [monitorEnvironment],
    );
    return (result.rows ?? []).map(mapParameterCheckRow);
  }
}

function buildLatestParameterChecksQuery({ hasLimit }) {
  return `
    with latest_checks as (
      select distinct on (parameter_key)
        check_id, parameter_key, monitor_environment, checked_at, status,
        check_type, latency_ms, failure_kind, observed_expires_at,
        days_until_due, evidence_source, message, details_json
      from monitor.system_config_parameter_checks
      where ($1::text is null or monitor_environment = $1)
      order by parameter_key, checked_at desc, check_id desc
    ), health_history as (
      select parameter_key, max(checked_at) filter (where status = 'healthy') as last_healthy_at
      from monitor.system_config_parameter_checks
      where ($1::text is null or monitor_environment = $1)
      group by parameter_key
    )
    select
      p.parameter_key, p.monitor_environment, p.parameter_name, p.scope, p.category,
      p.required, p.sensitive, p.health_probe_key, p.health_check_type,
      p.validity_mode, p.valid_from, p.expires_at, p.review_after_at,
      p.rotation_cycle_days, p.warning_days, p.critical_days, p.owner,
      p.source_doc, p.source_code_json, p.metadata_json,
      c.check_id, c.checked_at, coalesce(c.status, 'unknown') as status,
      coalesce(c.check_type, p.health_check_type) as check_type,
      c.latency_ms, c.failure_kind, c.observed_expires_at, c.days_until_due,
      coalesce(c.evidence_source, 'registry') as evidence_source,
      c.message, coalesce(c.details_json, '{}'::jsonb) as details_json,
      h.last_healthy_at
    from monitor.system_config_parameters p
    left join latest_checks c on c.parameter_key = p.parameter_key
    left join health_history h on h.parameter_key = p.parameter_key
    where ($1::text is null or p.monitor_environment = $1)
    order by
      case coalesce(c.status, 'unknown')
        when 'invalid' then 1
        when 'missing' then 2
        when 'unreachable' then 3
        when 'unknown' then 4
        when 'unsupported' then 5
        when 'present' then 6
        when 'not_configured' then 7
        when 'healthy' then 8
        else 9
      end,
      c.checked_at desc nulls last,
      p.parameter_name asc
    ${hasLimit ? 'limit $2' : ''}
  `;
}

function mapParameterCheckRow(row) {
  return {
    parameterKey: row.parameter_key,
    monitorEnvironment: row.monitor_environment,
    parameterName: row.parameter_name,
    scope: row.scope,
    category: row.category,
    required: Boolean(row.required),
    sensitive: Boolean(row.sensitive),
    healthProbeKey: row.health_probe_key,
    healthCheckType: row.health_check_type,
    validityMode: row.validity_mode,
    validFrom: normalizeTime(row.valid_from),
    expiresAt: normalizeTime(row.expires_at),
    reviewAfterAt: normalizeTime(row.review_after_at),
    rotationCycleDays: normalizeInteger(row.rotation_cycle_days),
    warningDays: normalizeInteger(row.warning_days) ?? 30,
    criticalDays: normalizeInteger(row.critical_days) ?? 7,
    owner: row.owner,
    sourceDoc: row.source_doc,
    sourceCode: normalizeJson(row.source_code_json, []),
    metadata: normalizeJson(row.metadata_json, {}),
    checkId: normalizeInteger(row.check_id),
    checkedAt: normalizeTime(row.checked_at),
    status: row.status ?? 'unknown',
    checkType: row.check_type ?? row.health_check_type,
    latencyMs: normalizeInteger(row.latency_ms),
    failureKind: row.failure_kind,
    observedExpiresAt: normalizeTime(row.observed_expires_at),
    daysUntilDue: normalizeInteger(row.days_until_due),
    evidenceSource: row.evidence_source,
    message: row.message,
    details: normalizeJson(row.details_json, {}),
    lastHealthyAt: normalizeTime(row.last_healthy_at),
  };
}

function normalizeJson(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function normalizeTime(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeNullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
