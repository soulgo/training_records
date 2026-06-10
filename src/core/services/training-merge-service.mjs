import {
  buildTrainingDay,
  emptyNutrition,
  emptySleep,
} from '../../domain/training/training-domain.mjs';
import {
  TrainingRecord,
  normalizeBatchActivity,
  normalizeBatchSleep,
} from '../entities/training-record.mjs';

export {
  buildTrainingDay,
  emptyNutrition,
  emptySleep,
  normalizeBatchActivity,
  normalizeBatchSleep,
};

export function mergeBatchIntoDay(existingDay, batch) {
  return TrainingRecord.merge(existingDay, batch);
}
