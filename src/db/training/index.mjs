// Training DB facade entry point.
// SQL remains in tools/training-db-*.mjs for compatibility during P0.
// Future repositories should move here without changing the public behavior.

export * from './config.mjs';
export * from './read.mjs';
export * from './write.mjs';
export * from './archive.mjs';
export * from './consistency-check.mjs';
