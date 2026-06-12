export class BodyMetric {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    return new BodyMetric(raw);
  }
}
