export class SleepRecord {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    return new SleepRecord(raw);
  }
}
