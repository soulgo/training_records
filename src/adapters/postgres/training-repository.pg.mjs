import { TrainingRepositoryPort } from '../../core/repositories/training-repository.port.mjs';
import { readCoreDay, readCoreDays, writeCoreDays } from './core-day-repository.pg.mjs';

export class PostgresTrainingRepository extends TrainingRepositoryPort {
  constructor(client) {
    super();
    if (!client?.query) {
      throw new Error('PostgresTrainingRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async findByDate(date) {
    return readCoreDay(this.client, date);
  }

  async findByDates(dates) {
    return readCoreDays(this.client, dates);
  }

  async save(record, options = {}) {
    await writeCoreDays(this.client, [record], options);
  }
}
