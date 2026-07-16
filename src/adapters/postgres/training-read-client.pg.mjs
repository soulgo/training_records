import {
  ARCHIVE_TRAINING_ACTIVITY_QUERY,
  ARCHIVE_TRAINING_DAY_QUERY,
  ARCHIVE_TRAINING_MEAL_QUERY,
  ARCHIVE_TRAINING_MEASUREMENT_QUERY,
  ARCHIVE_TRAINING_SLEEP_QUERY,
  BODY_FEEDBACK_QUERY,
  TRAINING_ACTIVITY_QUERY,
  TRAINING_DAY_QUERY,
  TRAINING_MEAL_QUERY,
  TRAINING_MEASUREMENT_QUERY,
  TRAINING_SLEEP_QUERY,
} from './training-read-queries.pg.mjs';
import { buildTrainingSnapshotFromRows } from './training-read-mapper.pg.mjs';

export async function readTrainingSnapshotFromDatabaseClient(client, now, dateFrom, dateTo) {
  const dayResult = await client.query(TRAINING_DAY_QUERY);
  const measurementResult = await client.query(TRAINING_MEASUREMENT_QUERY);
  const activityResult = await client.query(TRAINING_ACTIVITY_QUERY);
  const mealResult = await client.query(TRAINING_MEAL_QUERY);
  const sleepResult = await client.query(TRAINING_SLEEP_QUERY);
  const bodyFeedbackResult = await client.query(BODY_FEEDBACK_QUERY);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    sleepRows: sleepResult.rows,
    bodyFeedbackRows: bodyFeedbackResult.rows,
    now,
    dateFrom,
    dateTo,
  });
}

export async function readTrainingSnapshotFromDatabaseWithClients({ createClient, config, now, dateFrom, dateTo }) {
  try {
    return await readTrainingSnapshotFromDatabaseWithParallelClients({
      createClient,
      config,
      now,
      dateFrom,
      dateTo,
    });
  } catch (error) {
    process.stderr.write(
      `[training-db-read] parallel database snapshot read failed: ${formatErrorMessage(error)}; retrying with one client\n`,
    );
    const client = createClient(config);
    try {
      await client.connect();
      return await readTrainingSnapshotFromDatabaseClient(client, now, dateFrom, dateTo);
    } finally {
      await client.end?.();
    }
  }
}

async function readTrainingSnapshotFromDatabaseWithParallelClients({ createClient, config, now, dateFrom, dateTo }) {
  const clients = Array.from({ length: 6 }, () => createClient(config));

  try {
    await Promise.all(clients.map((client) => client.connect()));

    const [dayResult, measurementResult, activityResult, mealResult, sleepResult, bodyFeedbackResult] = await Promise.all([
      clients[0].query(TRAINING_DAY_QUERY),
      clients[1].query(TRAINING_MEASUREMENT_QUERY),
      clients[2].query(TRAINING_ACTIVITY_QUERY),
      clients[3].query(TRAINING_MEAL_QUERY),
      clients[4].query(TRAINING_SLEEP_QUERY),
      clients[5].query(BODY_FEEDBACK_QUERY),
    ]);

    return buildTrainingSnapshotFromRows({
      dayRows: dayResult.rows,
      measurementRows: measurementResult.rows,
      activityRows: activityResult.rows,
      mealRows: mealResult.rows,
      sleepRows: sleepResult.rows,
      bodyFeedbackRows: bodyFeedbackResult.rows,
      now,
      dateFrom,
      dateTo,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end?.()));
  }
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function readArchiveTrainingSnapshotFromDatabaseClient(client, now) {
  const dayResult = await client.query(ARCHIVE_TRAINING_DAY_QUERY);
  const measurementResult = await client.query(ARCHIVE_TRAINING_MEASUREMENT_QUERY);
  const activityResult = await client.query(ARCHIVE_TRAINING_ACTIVITY_QUERY);
  const mealResult = await client.query(ARCHIVE_TRAINING_MEAL_QUERY);
  const sleepResult = await client.query(ARCHIVE_TRAINING_SLEEP_QUERY);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    sleepRows: sleepResult.rows,
    now,
  });
}

export async function readArchiveTrainingSnapshotFromDatabaseWithClients({
  createClient,
  config,
  now,
  dateFrom,
  dateTo,
}) {
  const clients = Array.from({ length: 5 }, () => createClient(config));

  try {
    await Promise.all(clients.map((client) => client.connect()));

    const [dayResult, measurementResult, activityResult, mealResult, sleepResult] = await Promise.all([
      clients[0].query(ARCHIVE_TRAINING_DAY_QUERY),
      clients[1].query(ARCHIVE_TRAINING_MEASUREMENT_QUERY),
      clients[2].query(ARCHIVE_TRAINING_ACTIVITY_QUERY),
      clients[3].query(ARCHIVE_TRAINING_MEAL_QUERY),
      clients[4].query(ARCHIVE_TRAINING_SLEEP_QUERY),
    ]);

    return buildTrainingSnapshotFromRows({
      dayRows: dayResult.rows,
      measurementRows: measurementResult.rows,
      activityRows: activityResult.rows,
      mealRows: mealResult.rows,
      sleepRows: sleepResult.rows,
      now,
      dateFrom,
      dateTo,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end?.()));
  }
}
