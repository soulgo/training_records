import path from 'node:path';
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Hexo = require('hexo');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');

export async function validateGeneratedSiteOutput({ rootDir, command }) {
  if (command !== 'generate') {
    return;
  }

  const homepagePath = path.join(rootDir, 'public', 'index.html');
  let homepageStats;
  try {
    homepageStats = await stat(homepagePath);
  } catch (error) {
    throw new Error(`Generated homepage is missing at ${homepagePath}`, { cause: error });
  }

  if (!homepageStats.isFile() || homepageStats.size === 0) {
    throw new Error(`Generated homepage is empty at ${homepagePath}`);
  }
}

export async function runHexoCommand({ rootDir = defaultRootDir, command }) {
  if (!command) {
    throw new Error('Missing Hexo command. Usage: node tools/run-hexo-command.mjs <command>');
  }

  const hexo = new Hexo(rootDir, {
    _: [command],
    silent: false,
  });

  try {
    hexo.env.init = true;
    await hexo.init();
    await hexo.call(command, {});
    await validateGeneratedSiteOutput({ rootDir, command });
    await hexo.exit();
  } catch (error) {
    await hexo.exit(error);
    throw error;
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (invokedFile === fileURLToPath(import.meta.url)) {
  await runHexoCommand({
    rootDir: defaultRootDir,
    command: process.argv[2],
  });
}
