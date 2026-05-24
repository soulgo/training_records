const TELEGRAM_COMMAND_REGISTRY = Object.freeze([
  Object.freeze({
    name: 'move',
    priority: 1,
    aliases: ['/move', '/移动', '/thought', '/随想'],
  }),
  Object.freeze({
    name: 'delete',
    priority: 2,
    aliases: ['/thought-delete', '/thoughtdel', '/delete-thought', '/删随想', '/随想删'],
  }),
  Object.freeze({
    name: 'analysis',
    priority: 3,
    aliases: ['/analysis', '/分析'],
  }),
  Object.freeze({
    name: 'explicit_edit',
    priority: 4,
    aliases: ['/thought-edit', '/thoughtedit', '/edit-thought', '/编随想', '/随想编'],
  }),
  Object.freeze({
    name: 'edited_message',
    priority: 5,
    aliases: [],
  }),
  Object.freeze({
    name: 'reply_edit',
    priority: 6,
    aliases: [],
  }),
  Object.freeze({
    name: 'thought',
    priority: 7,
    aliases: ['/thought', '/随想'],
  }),
  Object.freeze({
    name: 'image',
    priority: 8,
    aliases: [],
  }),
]);

export { TELEGRAM_COMMAND_REGISTRY };

export function getTelegramCommandRegistry() {
  return TELEGRAM_COMMAND_REGISTRY;
}

export function createTelegramCommandResolver(handlers = {}) {
  const registry = TELEGRAM_COMMAND_REGISTRY.map((entry) => ({
    ...entry,
    handler: handlers[entry.name] ?? null,
  }));

  return {
    registry,
    resolve(normalized, context = {}) {
      for (const entry of registry) {
        const handler = entry.handler;
        if (!handler?.match) {
          continue;
        }

        const parsed = handler.match(normalized, context);
        if (!parsed) {
          continue;
        }

        const result = handler.build ? handler.build(normalized, context, parsed) : null;
        if (!result) {
          continue;
        }

        const effects = typeof handler.effects === 'function'
          ? handler.effects(normalized, context, parsed, result) ?? []
          : [];

        if (typeof result === 'object' && ('batch' in result || 'consumed' in result)) {
          return {
            ...result,
            name: entry.name,
            priority: entry.priority,
            aliases: entry.aliases,
            parsed,
            effects: result.effects ?? effects,
          };
        }

        return {
          name: entry.name,
          priority: entry.priority,
          aliases: entry.aliases,
          parsed,
          batch: result,
          consumed: true,
          effects,
        };
      }

      return null;
    },
  };
}
