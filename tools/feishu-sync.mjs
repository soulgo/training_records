import {
  buildFeishuSyncReport,
  main,
  notifyFeishuSyncResultFromFile,
  notifyFeishuSyncResultFromReport,
  runFeishuSync,
} from '../src/app/use-cases/feishu-sync.use-case.mjs';

export {
  buildFeishuSyncReport,
  notifyFeishuSyncResultFromFile,
  notifyFeishuSyncResultFromReport,
  runFeishuSync,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
