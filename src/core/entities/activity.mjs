export class Activity {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    return new Activity(raw);
  }
}
