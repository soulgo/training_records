import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Hexo = require('hexo');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const command = process.argv[2];

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
  await hexo.exit();
} catch (error) {
  await hexo.exit(error);
  throw error;
}
