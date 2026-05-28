// Telegram sync batch helpers.
// P0 keeps these helpers compatible with tools/telegram-sync-lib.mjs.

export {
  groupTelegramUpdates,
  analyzeTelegramBatch,
  applyTelegramSyncToMarkdown,
  processTelegramUpdates,
  mapWithConcurrency,
} from '../../tools/telegram-sync-lib.mjs';
