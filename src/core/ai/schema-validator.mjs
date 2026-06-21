import { AiProviderError, AiSchemaError } from './errors.mjs';

export { AiProviderError, AiSchemaError };

export function extractAiResponseContent(payload, options = {}) {
  const label = options.label ?? 'AI response';
  const content = payload?.choices?.[0]?.message?.content;

  if (content === null || content === undefined || String(content).trim() === '') {
    throw new AiProviderError(`${label} returned empty content`, {
      schemaName: options.schemaName,
      schemaVersion: options.schemaVersion,
    });
  }

  return content;
}

export function normalizeAiUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    };
  }

  return {
    promptTokens: normalizeNonNegativeInteger(value.promptTokens ?? value.prompt_tokens),
    completionTokens: normalizeNonNegativeInteger(value.completionTokens ?? value.completion_tokens),
    totalTokens: normalizeNonNegativeInteger(value.totalTokens ?? value.total_tokens),
    costUsd: normalizeNonNegativeNumber(value.costUsd ?? value.cost_usd),
  };
}

export function parseAiJsonContent(content, schema, options = {}) {
  const schemaName = options.schemaName ?? 'ai_schema';
  const schemaVersion = options.schemaVersion ?? 'v1';
  const rootPath = options.path ?? '$';
  const normalizedContent = typeof content === 'string' ? content.trim() : content;

  if (normalizedContent === '' || normalizedContent === null || normalizedContent === undefined) {
    throw new AiProviderError(`${schemaName} returned empty content`, {
      schemaName,
      schemaVersion,
      path: rootPath,
    });
  }

  const value = parseJsonLikeContent(normalizedContent, { schemaName, schemaVersion, rootPath });
  validateAiJsonValue(value, schema, {
    schemaName,
    schemaVersion,
    path: rootPath,
    allowAdditionalProperties: options.allowAdditionalProperties ?? false,
  });

  return value;
}

function parseJsonLikeContent(content, { schemaName, schemaVersion, rootPath }) {
  if (typeof content !== 'string') {
    return content;
  }

  const candidates = collectJsonCandidates(content);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new AiSchemaError(`${schemaName} returned invalid JSON`, {
    cause: lastError,
    schemaName,
    schemaVersion,
    path: rootPath,
  });
}

function normalizeNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

function normalizeNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return number;
}

function collectJsonCandidates(content) {
  const candidates = [];
  const trimmed = String(content ?? '').trim();
  if (!trimmed) {
    return candidates;
  }

  candidates.push(trimmed);

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^data:\s*$/i.test(line))
    .map((line) => line.replace(/^data:\s*/i, ''));

  if (dataLines.length > 0) {
    candidates.push(dataLines.join('\n').trim());
  }

  const jsonStart = trimmed.search(/[{[]/);
  const jsonEnd = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    candidates.push(trimmed.slice(jsonStart, jsonEnd + 1).trim());
  }

  candidates.push(...extractBalancedJsonCandidates(trimmed));

  return [...new Set(candidates.filter(Boolean))];
}

function extractBalancedJsonCandidates(content) {
  const candidates = [];
  const text = String(content ?? '');

  for (let index = 0; index < text.length; index += 1) {
    const startChar = text[index];
    if (startChar !== '{' && startChar !== '[') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }

      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(index, cursor + 1).trim());
          break;
        }
      }
    }
  }

  return candidates;
}

export function validateAiJsonValue(value, schema, options = {}) {
  const schemaName = options.schemaName ?? 'ai_schema';
  const schemaVersion = options.schemaVersion ?? 'v1';
  const path = options.path ?? '$';
  const allowAdditionalProperties = options.allowAdditionalProperties ?? false;

  validateValue(value, schema, { schemaName, schemaVersion, path, allowAdditionalProperties });
  return value;
}

function validateValue(value, schema, context) {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  const { schemaName, schemaVersion, path, allowAdditionalProperties } = context;

  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    throw schemaError(`${schemaName} expected one of ${schema.enum.join(', ')}`, {
      schemaName,
      schemaVersion,
      path,
    });
  }

  if (schema.pattern && typeof value === 'string') {
    const pattern = new RegExp(schema.pattern);
    if (!pattern.test(value)) {
      throw schemaError(`${schemaName} value at ${path} does not match pattern ${schema.pattern}`, {
        schemaName,
        schemaVersion,
        path,
      });
    }
  }

  const allowedTypes = normalizeTypes(schema.type);
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    throw schemaError(`${schemaName} expected ${allowedTypes.join(' or ')} at ${path}`, {
      schemaName,
      schemaVersion,
      path,
    });
  }

  if (isObjectSchema(schema) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    validateObject(value, schema, context);
    return;
  }

  if (isArraySchema(schema) && Array.isArray(value)) {
    validateArray(value, schema, context);
  }
}

function validateObject(value, schema, context) {
  const { schemaName, schemaVersion, path, allowAdditionalProperties } = context;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw schemaError(`${schemaName} missing required field ${path}.${key}`, {
        schemaName,
        schemaVersion,
        path: `${path}.${key}`,
      });
    }
  }

  if (schema.additionalProperties === false && !allowAdditionalProperties) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw schemaError(`${schemaName} has unexpected field ${path}.${key}`, {
          schemaName,
          schemaVersion,
          path: `${path}.${key}`,
        });
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    validateValue(value[key], propertySchema, {
      schemaName,
      schemaVersion,
      path: `${path}.${key}`,
      allowAdditionalProperties: false,
    });
  }
}

function validateArray(value, schema, context) {
  const itemsSchema = schema.items;
  if (!itemsSchema) {
    return;
  }

  for (const [index, item] of value.entries()) {
    validateValue(item, itemsSchema, {
      ...context,
      path: `${context.path}[${index}]`,
    });
  }
}

function normalizeTypes(type) {
  if (!type) {
    return [];
  }
  return Array.isArray(type) ? type : [type];
}

function matchesType(value, type) {
  if (type === 'null') {
    return value === null;
  }
  if (type === 'string') {
    return typeof value === 'string';
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (type === 'integer') {
    return Number.isInteger(value);
  }
  if (type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'object') {
    return isPlainObject(value);
  }
  return true;
}

function isObjectSchema(schema) {
  const types = normalizeTypes(schema.type);
  return types.includes('object') || Boolean(schema.properties) || Boolean(schema.required);
}

function isArraySchema(schema) {
  const types = normalizeTypes(schema.type);
  return types.includes('array') || Boolean(schema.items);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(message, options = {}) {
  return new AiSchemaError(message, options);
}
