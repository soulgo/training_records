import {
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from '../domain/training/training-snapshot.mjs';

export function canFallbackToMarkdownSnapshot(error) {
  return isIncompleteDatabaseSnapshotError(error) || isUnavailableDatabaseSnapshotError(error);
}

export function canUseDatabaseFallback({ source, config } = {}) {
  return source === 'database' && Boolean(config?.enabled) && Boolean(config?.url);
}
