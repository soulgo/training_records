export class HealthDaily {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    if (!raw.date) {
      throw new Error('HealthDaily.date is required');
    }
    return new HealthDaily(raw);
  }
}
