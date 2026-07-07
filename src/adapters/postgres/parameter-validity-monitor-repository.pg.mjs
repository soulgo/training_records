export class PostgresParameterValidityMonitorRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresParameterValidityMonitorRepository requires a pg client-like object');
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
          parameter_key,
          monitor_environment,
          parameter_name,
          scope,
          category,
          required,
          sensitive,
          validity_mode,
          valid_from,
          expires_at,
          review_after_at,
          rotation_cycle_days,
          warning_days,
          critical_days,
          owner,
          source_doc,
          source_code_json,
          metadata_json,
          updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17::jsonb, $18::jsonb, now()
        )
        on conflict (parameter_key) do update set
          monitor_environment = excluded.monitor_environment,
          parameter_name = excluded.parameter_name,
          scope = excluded.scope,
          category = excluded.category,
          required = excluded.required,
          sensitive = excluded.sensitive,
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
          parameter_key,
          monitor_environment,
          run_id,
          checked_at,
          status,
          days_until_due,
          evidence_source,
          message,
          details_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        check.parameterKey,
        check.environment,
        check.runId ?? null,
        check.checkedAt ?? new Date().toISOString(),
        check.status,
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
        check_id,
        parameter_key,
        monitor_environment,
        checked_at,
        status,
        days_until_due,
        evidence_source,
        message,
        details_json
      from monitor.system_config_parameter_checks
      where ($1::text is null or monitor_environment = $1)
      order by parameter_key, checked_at desc, check_id desc
    )
    select
      p.parameter_key,
      p.monitor_environment,
      p.parameter_name,
      p.scope,
      p.category,
      p.required,
      p.sensitive,
      p.validity_mode,
      p.valid_from,
      p.expires_at,
      p.review_after_at,
      p.rotation_cycle_days,
      p.warning_days,
      p.critical_days,
      p.owner,
      p.source_doc,
      p.source_code_json,
      p.metadata_json,
      c.check_id,
      c.checked_at,
      c.status,
      c.days_until_due,
      c.evidence_source,
      c.message,
      c.details_json
    from monitor.system_config_parameters p
    left join latest_checks c on c.parameter_key = p.parameter_key
    where ($1::text is null or p.monitor_environment = $1)
    order by
      case coalesce(c.status, 'unknown')
        when 'expired' then 1
        when 'missing' then 2
        when 'warning' then 3
        when 'unknown' then 4
        when 'ok' then 5
        else 6
      end,
      coalesce(p.expires_at, p.review_after_at) asc nulls last,
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
    daysUntilDue: normalizeInteger(row.days_until_due),
    evidenceSource: row.evidence_source,
    message: row.message,
    details: normalizeJson(row.details_json, {}),
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

function normalizeNullableText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeLimit(value) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
}

function normalizeTime(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
