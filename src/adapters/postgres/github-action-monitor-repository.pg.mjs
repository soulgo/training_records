export class PostgresGitHubActionMonitorRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresGitHubActionMonitorRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async upsertActionRunSnapshot(snapshot) {
    try {
      await this.upsertActionRunSnapshotWithSchema(snapshot, { useMonitorEnvironmentColumn: true });
    } catch (error) {
      if (!isMissingMonitorEnvironmentColumnError(error)) {
        throw error;
      }
      await this.upsertActionRunSnapshotWithSchema(snapshot, { useMonitorEnvironmentColumn: false });
    }
  }

  async upsertActionRunSnapshotWithSchema(snapshot, { useMonitorEnvironmentColumn }) {
    await this.client.query('begin');
    try {
      await this.upsertRun(snapshot.run, { useMonitorEnvironmentColumn });
      for (const job of snapshot.jobs ?? []) {
        await this.upsertJob(job);
      }
      for (const step of snapshot.steps ?? []) {
        await this.upsertStep(step);
      }
      await this.client.query('delete from monitor.github_action_failures where run_id = $1', [snapshot.run.runId]);
      for (const failure of snapshot.failures ?? []) {
        await this.upsertFailure(failure, { useMonitorEnvironmentColumn });
      }
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback');
      throw error;
    }
  }

  async listRecentActionRuns(options = {}) {
    const monitorEnvironment = normalizeNullableText(options.monitorEnvironment);
    const limit = normalizeLimit(options.limit, 12);
    let result;
    try {
      result = await this.client.query(
        buildRecentActionRunsQuery({ useMonitorEnvironmentColumn: true }),
        [monitorEnvironment, limit],
      );
    } catch (error) {
      if (!isMissingMonitorEnvironmentColumnError(error)) {
        throw error;
      }
      result = await this.client.query(
        buildRecentActionRunsQuery({ useMonitorEnvironmentColumn: false }),
        [monitorEnvironment, limit],
      );
    }

    return (result.rows ?? []).map(mapRecentActionRunRow);
  }

  async upsertRun(run, { useMonitorEnvironmentColumn } = { useMonitorEnvironmentColumn: true }) {
    const columns = [
      { name: 'run_id', value: run.runId },
      { name: 'repository_full_name', value: run.repositoryFullName },
      ...(useMonitorEnvironmentColumn ? [{ name: 'monitor_environment', value: run.monitorEnvironment }] : []),
      { name: 'workflow_id', value: run.workflowId },
      { name: 'workflow_name', value: run.workflowName },
      { name: 'workflow_path', value: run.workflowPath },
      { name: 'run_number', value: run.runNumber },
      { name: 'run_attempt', value: run.runAttempt },
      { name: 'event', value: run.event },
      { name: 'branch', value: run.branch },
      { name: 'commit_sha', value: run.commitSha },
      { name: 'head_commit_message', value: run.headCommitMessage },
      { name: 'actor_login', value: run.actorLogin },
      { name: 'status', value: run.status },
      { name: 'conclusion', value: run.conclusion },
      { name: 'start_time', value: run.startTime },
      { name: 'end_time', value: run.endTime },
      { name: 'duration', value: run.duration },
      { name: 'html_url', value: run.htmlUrl },
      { name: 'error_summary', value: run.errorSummary },
      { name: 'raw_payload_json', value: JSON.stringify(run.rawPayload ?? {}), cast: 'jsonb' },
    ];
    const { sql, params } = buildUpsertSql({
      table: 'monitor.github_action_runs',
      conflictTarget: 'run_id',
      columns,
    });

    await this.client.query(sql, params);
  }

  async upsertJob(job) {
    await this.client.query(
      `
        insert into monitor.github_action_jobs (
          job_id,
          run_id,
          job_name,
          status,
          conclusion,
          start_time,
          end_time,
          duration,
          html_url,
          runner_name,
          runner_group_name,
          labels_json,
          raw_payload_json,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, now())
        on conflict (job_id) do update set
          run_id = excluded.run_id,
          job_name = excluded.job_name,
          status = excluded.status,
          conclusion = excluded.conclusion,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          duration = excluded.duration,
          html_url = excluded.html_url,
          runner_name = excluded.runner_name,
          runner_group_name = excluded.runner_group_name,
          labels_json = excluded.labels_json,
          raw_payload_json = excluded.raw_payload_json,
          updated_at = excluded.updated_at
      `,
      [
        job.jobId,
        job.runId,
        job.jobName,
        job.status,
        job.conclusion,
        job.startTime,
        job.endTime,
        job.duration,
        job.htmlUrl,
        job.runnerName,
        job.runnerGroupName,
        JSON.stringify(job.labels ?? []),
        JSON.stringify(job.rawPayload ?? {}),
      ],
    );
  }

  async upsertStep(step) {
    await this.client.query(
      `
        insert into monitor.github_action_steps (
          job_id,
          run_id,
          step_number,
          step_name,
          status,
          conclusion,
          start_time,
          end_time,
          duration,
          raw_payload_json,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
        on conflict (job_id, step_number) do update set
          run_id = excluded.run_id,
          step_name = excluded.step_name,
          status = excluded.status,
          conclusion = excluded.conclusion,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          duration = excluded.duration,
          raw_payload_json = excluded.raw_payload_json,
          updated_at = excluded.updated_at
      `,
      [
        step.jobId,
        step.runId,
        step.stepNumber,
        step.stepName,
        step.status,
        step.conclusion,
        step.startTime,
        step.endTime,
        step.duration,
        JSON.stringify(step.rawPayload ?? {}),
      ],
    );
  }

  async upsertFailure(failure, { useMonitorEnvironmentColumn } = { useMonitorEnvironmentColumn: true }) {
    const columns = [
      { name: 'failure_key', value: failure.failureKey },
      { name: 'run_id', value: failure.runId },
      { name: 'job_id', value: failure.jobId },
      { name: 'step_number', value: failure.stepNumber },
      { name: 'failure_level', value: failure.failureLevel },
      ...(useMonitorEnvironmentColumn ? [{ name: 'monitor_environment', value: failure.monitorEnvironment }] : []),
      { name: 'workflow_name', value: failure.workflowName },
      { name: 'job_name', value: failure.jobName },
      { name: 'step_name', value: failure.stepName },
      { name: 'conclusion', value: failure.conclusion },
      { name: 'error_summary', value: failure.errorSummary },
      { name: 'context_json', value: JSON.stringify(failure.context ?? {}), cast: 'jsonb' },
    ];
    const { sql, params } = buildUpsertSql({
      table: 'monitor.github_action_failures',
      conflictTarget: 'failure_key',
      columns,
    });

    await this.client.query(sql, params);
  }
}

function mapRecentActionRunRow(row) {
  return {
    runId: normalizeInteger(row.run_id),
    repositoryFullName: row.repository_full_name,
    monitorEnvironment: row.monitor_environment,
    workflowId: normalizeInteger(row.workflow_id),
    workflowName: row.workflow_name,
    workflowPath: row.workflow_path,
    runNumber: normalizeInteger(row.run_number),
    runAttempt: normalizeInteger(row.run_attempt),
    event: row.event,
    branch: row.branch,
    commitSha: row.commit_sha,
    headCommitMessage: row.head_commit_message,
    actorLogin: row.actor_login,
    status: row.status,
    conclusion: row.conclusion,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    duration: normalizeInteger(row.duration),
    htmlUrl: row.html_url,
    errorSummary: row.error_summary,
    jobCount: normalizeInteger(row.job_count) ?? 0,
    stepCount: normalizeInteger(row.step_count) ?? 0,
    failureCount: normalizeInteger(row.failure_count) ?? 0,
  };
}

function buildUpsertSql({ table, conflictTarget, columns }) {
  const insertColumns = [...columns.map((column) => column.name), 'updated_at'];
  const values = columns.map((column, index) => {
    const placeholder = `$${index + 1}`;
    return column.cast ? `${placeholder}::${column.cast}` : placeholder;
  });
  const updateColumns = insertColumns.filter((column) => column !== conflictTarget);
  return {
    sql: `
        insert into ${table} (
          ${insertColumns.join(',\n          ')}
        )
        values (${[...values, 'now()'].join(', ')})
        on conflict (${conflictTarget}) do update set
          ${updateColumns.map((column) => `${column} = excluded.${column}`).join(',\n          ')}
      `,
    params: columns.map((column) => column.value),
  };
}

function buildRecentActionRunsQuery({ useMonitorEnvironmentColumn }) {
  const monitorEnvironmentSelect = useMonitorEnvironmentColumn
    ? 'r.monitor_environment'
    : '$1::text as monitor_environment';
  const environmentScope = useMonitorEnvironmentColumn
    ? 'r.monitor_environment = $1'
    : 'r.branch = $1';

  return `
        select
          r.run_id,
          r.repository_full_name,
          ${monitorEnvironmentSelect},
          r.workflow_id,
          r.workflow_name,
          r.workflow_path,
          r.run_number,
          r.run_attempt,
          r.event,
          r.branch,
          r.commit_sha,
          r.head_commit_message,
          r.actor_login,
          r.status,
          r.conclusion,
          r.start_time,
          r.end_time,
          r.duration,
          r.html_url,
          r.error_summary,
          count(distinct j.job_id)::integer as job_count,
          count(distinct s.step_id)::integer as step_count,
          count(distinct f.failure_key)::integer as failure_count
        from monitor.github_action_runs r
        left join monitor.github_action_jobs j on j.run_id = r.run_id
        left join monitor.github_action_steps s on s.run_id = r.run_id
        left join monitor.github_action_failures f on f.run_id = r.run_id
        where ($1::text is null or ${environmentScope})
        group by r.run_id
        order by coalesce(r.start_time, r.created_at) desc, r.run_id desc
        limit $2
      `;
}

function isMissingMonitorEnvironmentColumnError(error) {
  return error?.code === '42703' && /monitor_environment/i.test(String(error.message ?? ''));
}

function normalizeNullableText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeLimit(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    return fallback;
  }
  return Math.min(numberValue, 50);
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
