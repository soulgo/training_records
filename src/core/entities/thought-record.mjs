export class ThoughtRecord {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    if (!raw.id && !raw.telegramMessageId && !raw.title) {
      throw new Error('ThoughtRecord requires an id, telegramMessageId, or title');
    }
    return new ThoughtRecord(raw);
  }
}
