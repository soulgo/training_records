import { fetchTelegramUpdates } from './polling.transport.mjs';
import { sendTelegramMessage } from './telegram-api.mjs';
import { TelegramBotPort } from './telegram-bot.port.mjs';

export class TelegramBotAdapter extends TelegramBotPort {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  async fetchUpdates(options = {}) {
    return fetchTelegramUpdates({
      botToken: this.config.botToken,
      ...options,
    });
  }

  async sendMessage(options = {}) {
    return sendTelegramMessage({
      botToken: this.config.botToken,
      ...options,
    });
  }
}
