# V11 落地 checklist

本文用于核对 `telegram_sync_pgsql_markdown_speedup_v11.md` 中 P0 + 稳态 P1 范围的实现状态。状态基于 2026-06-08 当前代码与本地测试结果。

## 已完成

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 构建期 archive 写入门控 | 已完成 | `TRAINING_BUILD_ARCHIVE_WRITE=auto|true|false` 已接入 `generateTrainingData()`；`false` 与 `database + strict + auto` 会跳过 archive 写库并输出 skip 日志 |
| Deploy workflow 跳过 archive 写库 | 已完成 | `deploy-pages.yml` 与 `deploy-cloudflare-pages-dev.yml` 固定设置 `TRAINING_BUILD_ARCHIVE_WRITE=false` |
| OpenAI-compatible 配置透传 | 已完成 | `telegram-sync.yml` 与 `telegram-sync-dev.yml` 显式传入 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_CACHE_ENABLED` |
| archive 相同 source hash 早停 | 已完成 | `persistTrainingArchive()` 命中相同 `source_hash` 时只更新 `archive.training_parse_snapshot.last_seen_at` 并插入 `archive.training_parse_run` |
| archive 子表批量 upsert | 已完成 | `archive.training_day/measurement/activity/meal/sleep` 改为批量 `unnest` upsert |
| sleep backfill 条件化 | 已完成 | 仅显式开关、pending replay 入库 sleep、或当前新入库 sleep 图片触发；非 sleep 图片/重放不触发 |
| `core.training_day` 汇总单 SQL 化 | 已完成 | 增量汇总改为一条 CTE upsert，聚合 `core.activity`、`core.meal` 并读取 existing day 保留未覆盖模块 |
| 回归测试 | 已完成 | 已补充 archive、workflow、Telegram runner、core DB 测试；目标测试、`test:fast` 与完整 `npm test` 均已通过 |

## 未完成/后续观察

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| P2 图片尺寸选择优化 | 未完成 | 本轮范围锁定为 P0 + 稳态 P1；需要真实 Telegram 图片识别准确率观察后再决定 |
| 强制默认启用 recognition cache | 未完成 | 本轮只透传 `TELEGRAM_RECOGNITION_CACHE_ENABLED`，是否设为 `true` 交给 GitHub Variables 控制 |
| Telegram 同步 run-scoped PG client 复用 | 未完成 | 本轮未引入连接池或共享 client，避免扩大事务/失败边界；可作为后续独立优化 |

## 验证命令

```bash
node --test test/training-db-archive.test.mjs
node --test test/github-workflows.test.mjs
node --test test/telegram-sync-runner.test.mjs
node --test test/training-db-core.test.mjs
npm run test:fast
npm test
```

## 本地验证结果

| 命令 | 结果 |
| --- | --- |
| `node --test test/training-db-archive.test.mjs test/github-workflows.test.mjs test/telegram-sync-runner.test.mjs test/training-db-core.test.mjs` | 通过，142 tests |
| `npm run test:fast` | 通过，361 tests |
| `npm test` | 通过，377 tests |

## 验收备注

- deploy 构建日志应出现 `[training-db-archive] skipped by TRAINING_BUILD_ARCHIVE_WRITE=false`，并在 generated 文件后快速进入 Hexo build。
- Telegram Sync 日志中非 sleep 批次不应再固定出现 `sleepBackfill` 阶段。
- 切换 OpenAI-compatible 服务时，只需要调整 GitHub Variables / Secrets，不需要修改业务调用点。
