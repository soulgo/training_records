const dailyMonitorSectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 180 },
    },
  },
};

export const dailyMonitorReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'training', 'nutrition', 'recovery', 'other'],
  properties: {
    headline: { type: 'string', minLength: 1, maxLength: 160 },
    training: dailyMonitorSectionSchema,
    nutrition: dailyMonitorSectionSchema,
    recovery: dailyMonitorSectionSchema,
    other: dailyMonitorSectionSchema,
  },
};

export const dailyMonitorReportSchemaVersion = 'v1';
