import { buildTrainingSnapshotFromDaily } from '../../domain/training/training-domain.mjs';

export class TrainingSnapshotService {
  constructor({ trainingRepository, now = () => new Date() } = {}) {
    if (!trainingRepository?.findByDates) {
      throw new Error('TrainingSnapshotService requires a trainingRepository with findByDates');
    }
    this.trainingRepository = trainingRepository;
    this.now = now;
  }

  async buildByDates(dates = []) {
    const uniqueDates = [...new Set((dates ?? []).map(normalizeDateKey).filter(Boolean))];
    const daily = await this.trainingRepository.findByDates(uniqueDates);
    return this.buildFromDaily(daily);
  }

  buildFromDaily(daily = []) {
    return buildTrainingSnapshotFromDaily(daily, this.now().toISOString());
  }
}

function normalizeDateKey(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value ?? '');
}
