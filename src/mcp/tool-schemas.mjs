export function objectSchema(properties) {
  return {
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

export function stringSchema() {
  return { type: 'string' };
}

export function numberSchema() {
  return { type: 'number' };
}

export function booleanSchema() {
  return { type: 'boolean' };
}

export function dateSchema() {
  return {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  };
}

export function enumSchema(values) {
  return {
    type: 'string',
    enum: values,
  };
}

export function arraySchema(items) {
  return {
    type: 'array',
    items,
  };
}
