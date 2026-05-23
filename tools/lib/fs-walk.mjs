import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function readDirRecursive(dirPath, options = {}) {
  const { ignoreMissing = true } = options;
  const filter = typeof options.filter === 'function' ? options.filter : null;
  const results = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (ignoreMissing) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!filter || filter(entryPath, entry)) {
        results.push(entryPath);
      }
    }
  }

  await walk(dirPath);
  return results;
}
