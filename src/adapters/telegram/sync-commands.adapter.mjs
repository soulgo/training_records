import {
  DEFAULT_THOUGHT_MODULE,
  normalizeThoughtModule,
  resolveThoughtModuleLabel,
} from '../../core/thought-modules.mjs';
import { isTelegramHelpText } from '../../telegram/help.mjs';

export function buildThoughtBatch(message) {
  return buildThoughtBatchFromMessages([message]);
}

export function buildThoughtEditBatch(message, options = {}) {
  const parsedEditBody = extractEditedThoughtBody(message);
  const targetMessageId = normalizeMessageId(
    options.targetMessageId ?? message.replyToMessageId ?? message.messageId,
  );

  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages: [message],
    thoughtEdit: {
      command:
        parseThoughtCommand(message.text)?.command ??
        parseThoughtCommand(message.caption)?.command ??
        '/thought',
      targetMessageId,
      body: parsedEditBody.body,
      thoughtModule: parsedEditBody.moduleExplicit ? normalizeThoughtModule(parsedEditBody.moduleKey) : null,
    },
  };
}

export function buildExplicitThoughtEditBatch(message, parsedThoughtEdit) {
  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages: [message],
    thoughtEdit: {
      command: parsedThoughtEdit.command,
      targetMessageId: parsedThoughtEdit.targetMessageId,
      body: parsedThoughtEdit.body,
      thoughtModule: parsedThoughtEdit.moduleExplicit ? normalizeThoughtModule(parsedThoughtEdit.moduleKey) : null,
      replacePhotos: message.photos.length > 0,
    },
  };
}

export function buildExplicitThoughtEditBatchFromMessages(messages) {
  const parsedEntry = findThoughtEditCommandEntry(messages);
  if (!parsedEntry) {
    return null;
  }

  const { message, parsedThoughtEdit } = parsedEntry;
  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages,
    thoughtEdit: {
      command: parsedThoughtEdit.command,
      targetMessageId: parsedThoughtEdit.targetMessageId,
      body: parsedThoughtEdit.body,
      thoughtModule: parsedThoughtEdit.moduleExplicit ? normalizeThoughtModule(parsedThoughtEdit.moduleKey) : null,
      replacePhotos: messages.some((item) => (item.photos?.length ?? 0) > 0),
    },
  };
}

export function buildThoughtDeleteBatch(message) {
  const parsedDelete = parseThoughtDeleteCommand(message.text);
  if (!parsedDelete) {
    return null;
  }

  return {
    kind: 'thought_delete',
    batchId: `thought-delete-${message.messageId}`,
    messages: [message],
    thoughtDelete: {
      command: parsedDelete.command,
      targetMessageId: parsedDelete.targetMessageId ?? message.replyToMessageId ?? null,
      requestedTargetText: parsedDelete.requestedTargetText,
      replyToMessageId: message.replyToMessageId,
    },
  };
}

export function buildThoughtBatchFromMessages(messages) {
  const parsedEntry = findThoughtCommandEntry(messages);
  if (!parsedEntry) {
    return null;
  }

  const { message, parsedThought } = parsedEntry;
  if (!parsedThought) {
    return null;
  }

  return {
    kind: 'thought',
    batchId: `thought-${message.messageId}`,
    messages,
    thought: {
      command: parsedThought.command,
      body: parsedThought.body,
      thoughtModule: normalizeThoughtModule(parsedThought.moduleKey),
      sourceMessageId: message.messageId,
      invalidReason: parsedThought.invalidReason,
    },
  };
}

export function buildThoughtMoveBatch(message) {
  const parsedMove = parseThoughtMoveCommand(message.text);
  if (!parsedMove) {
    return null;
  }

  return {
    kind: 'thought_move',
    batchId: `thought-move-${message.messageId}`,
    messages: [message],
    thoughtMove: {
      command: parsedMove.command,
      targetMessageId: parsedMove.targetMessageId ?? message.replyToMessageId ?? null,
      requestedTargetText: parsedMove.requestedTargetText,
      replyToMessageId: message.replyToMessageId,
      thoughtModule: parsedMove.thoughtModule,
    },
  };
}

export function buildAnalysisBatch(message) {
  const parsedAnalysis = parseAnalysisCommand(message.text);
  if (!parsedAnalysis) {
    return null;
  }

  return {
    kind: 'analysis',
    batchId: `analysis-${message.messageId}`,
    messages: [message],
    analysis: {
      command: parsedAnalysis.command,
      question: parsedAnalysis.question,
    },
  };
}

export function buildHelpBatch(message) {
  const parsedHelp = parseHelpCommand(message.text);
  if (!parsedHelp) {
    return null;
  }

  return {
    kind: 'help',
    batchId: `help-${message.messageId}`,
    messages: [message],
    help: {
      command: parsedHelp.command,
    },
  };
}

export function parseThoughtCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(/^(\/(?:thought|随想)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return buildThoughtCommandPayload(match[1], match[2]);
}

export function parseThoughtEditCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:thought-edit|thoughtedit|edit-thought|编随想|随想编|随便编)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const rawBody = match[2].trim();
  const bodyMatch = rawBody.match(/^(\d+)(?:\s+([\s\S]*))?$/u);
  if (!bodyMatch) {
    return null;
  }

  const parsedBody = parseThoughtModuleBody(bodyMatch[2] ?? '');
  return {
    command: match[1],
    targetMessageId: normalizeMessageId(bodyMatch[1]),
    body: parsedBody.body,
    moduleKey: parsedBody.moduleKey,
    moduleExplicit: parsedBody.moduleExplicit,
  };
}

function extractEditedThoughtBody(message) {
  const parsedThought = parseThoughtCommand(message.text) ?? parseThoughtCommand(message.caption);
  if (parsedThought) {
    return {
      body: parsedThought.body,
      moduleKey: parsedThought.moduleKey,
      moduleExplicit: parsedThought.moduleExplicit,
    };
  }
  return parseThoughtModuleBody(message.text?.trim() || message.caption?.trim() || '');
}

export function parseThoughtDeleteCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:thought-delete|thoughtdel|delete-thought|删随想|随想删)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const requestedTargetText = match[2].trim();
  const idMatch = requestedTargetText.match(/^(\d+)\b/);

  return {
    command: match[1],
    requestedTargetText,
    targetMessageId: idMatch ? normalizeMessageId(idMatch[1]) : null,
  };
}

export function buildThoughtMessageKey(chatId, messageId) {
  return `${chatId ?? ''}:${messageId ?? ''}`;
}

export function normalizeMessageId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value > 0n ? value.toString() : null;
  }
  const text = String(value).trim();
  if (!/^\d+$/u.test(text) || text === '0') {
    return null;
  }
  const number = Number(text);
  return Number.isSafeInteger(number) && String(number) === text ? number : text;
}

export function parseThoughtMoveCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:move|移动|thought|随想)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const command = match[1];
  const requestedTargetText = match[2].trim();
  const idAndModuleMatch = requestedTargetText.match(/^(\d+)\s+(\S+)$/u);
  if (idAndModuleMatch) {
    const thoughtModule = resolveThoughtModuleLabel(idAndModuleMatch[2]);
    return thoughtModule
      ? {
          command,
          requestedTargetText,
          targetMessageId: normalizeMessageId(idAndModuleMatch[1]),
          thoughtModule,
        }
      : null;
  }

  if (/^\/(?:thought|随想)(?:@[A-Za-z0-9_]+)?$/u.test(command)) {
    return null;
  }

  const thoughtModule = resolveThoughtModuleLabel(requestedTargetText);
  if (!thoughtModule) {
    return null;
  }

  return {
    command,
    requestedTargetText,
    targetMessageId: null,
    thoughtModule,
  };
}

function buildThoughtCommandPayload(command, rawBody) {
  const invalidReason = getAmbiguousThoughtEditReason(rawBody);
  const parsedBody = parseThoughtModuleBody(rawBody);
  return {
    command,
    body: parsedBody.body,
    moduleKey: parsedBody.moduleKey,
    moduleExplicit: parsedBody.moduleExplicit,
    invalidReason,
  };
}

function getAmbiguousThoughtEditReason(rawBody) {
  const body = String(rawBody ?? '').trim();
  const match = body.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/u);
  if (!match) {
    return null;
  }
  return resolveThoughtModuleLabel(match[2])
    ? '疑似编辑命令，请使用 /随想编 id 模块 内容'
    : null;
}

function parseThoughtModuleBody(rawBody) {
  const body = String(rawBody ?? '').trim();
  const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return {
      moduleKey: DEFAULT_THOUGHT_MODULE,
      moduleExplicit: false,
      body,
    };
  }

  const moduleKey = resolveThoughtModuleLabel(match[1]);
  if (!moduleKey) {
    return {
      moduleKey: DEFAULT_THOUGHT_MODULE,
      moduleExplicit: false,
      body,
    };
  }

  return {
    moduleKey,
    moduleExplicit: true,
    body: (match[2] ?? '').trim(),
  };
}

function findThoughtCommandEntry(messages) {
  for (const message of messages ?? []) {
    for (const text of [message.text, message.caption]) {
      const parsedThought = parseThoughtCommand(text);
      if (parsedThought) {
        return {
          message,
          parsedThought,
        };
      }
    }
  }
  return null;
}

function findThoughtEditCommandEntry(messages) {
  for (const message of messages ?? []) {
    for (const text of [message.text, message.caption]) {
      const parsedThoughtEdit = parseThoughtEditCommand(text);
      if (parsedThoughtEdit) {
        return {
          message,
          parsedThoughtEdit,
        };
      }
    }
  }
  return null;
}

export function parseAnalysisCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(/^(\/(?:analysis|分析)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return {
    command: match[1],
    question: match[2].trim(),
  };
}

export function parseHelpCommand(text) {
  if (!isTelegramHelpText(text)) {
    return null;
  }

  return {
    command: String(text).trim(),
  };
}
