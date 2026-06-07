export function telegramSyncEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'token',
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    TELEGRAM_ALLOWED_CHAT_IDS: '42',
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    ...overrides,
  };
}

export function emptyTrainingCharts(overrides = {}) {
  return {
    weightKg: [],
    bodyFatPct: [],
    skeletalMuscleKg: [],
    basalMetabolism: [],
    visceralFatLevel: [],
    intakeCalories: [],
    trainingCalories: [],
    cyclingDistanceKm: [],
    ...overrides,
  };
}
