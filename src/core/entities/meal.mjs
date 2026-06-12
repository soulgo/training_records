export class Meal {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    return new Meal(raw);
  }
}
