# 维护脚本入口说明（第八轮）

> 目标：把只读排查、增量同步、迁移修复三类维护动作分开，减少临时脚本记忆成本。

---

## 1. 统一入口

第八轮新增统一维护入口：

```bash
npm run maintenance:inspect
npm run maintenance:sync
npm run maintenance:sync -- --phase archive
npm run maintenance:sync -- --phase ingest
npm run maintenance:sync -- --phase markdown
npm run maintenance:sync -- --phase thoughts
npm run export:markdown
npm run maintenance:migrate -- --dry-run
npm run maintenance:migrate -- --confirm
```

对应脚本为 `tools/training-maintenance.mjs`。旧的 `sync:db`、`backfill:*`、`reconcile:*`、`export:markdown`、`import:markdown` 作为 npm 兼容别名保留，但现在均转发到统一维护入口；旧工具文件继续保留，避免破坏模块导入和直接脚本调用习惯。

---

## 2. 命令边界

| 命令 | 类型 | 是否写数据 | 用途 |
| --- | --- | --- | --- |
| `maintenance:inspect` | inspect | 否 | 读取 runtime 队列、归档失败计数和数据库配置摘要 |
| `maintenance:sync` | sync | 是 | 调用现有 `syncTrainingCore`，默认安全同步 archive、ingest 修复和 thoughts 到 core |
| `maintenance:sync -- --phase archive` | sync | 是 | 仅同步 archive 到 core，兼容 `backfill:core` |
| `maintenance:sync -- --phase ingest` | sync | 是 | 仅运行 ingest 睡眠修复 |
| `maintenance:sync -- --phase markdown` | sync | 是 | 显式同步 Markdown 到 core，兼容 `import:markdown` 与 `reconcile:markdown` |
| `maintenance:sync -- --phase thoughts` | sync | 是 | 仅同步 thoughts 到 core，兼容 `backfill:thoughts` |
| `export:markdown` | export | 是 | 通过统一维护入口从数据库导出派生后的 `训练记录.md` |
| `maintenance:migrate -- --dry-run` | migrate | 否 | 输出迁移计划，不执行写入 |
| `maintenance:migrate -- --confirm` | migrate | 是 | 以 `maintenance_migrate` 来源执行确认后的迁移/修复同步 |

---

## 3. 安全规则

- 只读排查统一使用 `npm run maintenance:inspect`。
- 会写数据的普通增量同步统一使用 `npm run maintenance:sync`，该默认入口不执行 Markdown 回灌。
- 需要兼容旧单阶段动作时，使用 `npm run backfill:core`、`npm run backfill:thoughts`、`npm run import:markdown`、`npm run reconcile:markdown`；这些命令都会转发到 `tools/training-maintenance.mjs sync --phase ...`。
- `import:markdown` / `reconcile:markdown` 会用 Markdown 快照写数据库，只能作为显式人工维护入口使用。
- Markdown 导出继续使用 `npm run export:markdown`，但实际入口已统一到 `tools/training-maintenance.mjs export markdown`，默认严格读取数据库。
- 迁移类动作必须先运行 `npm run maintenance:migrate -- --dry-run`。
- 没有 `--dry-run` 或 `--confirm` 时，`maintenance:migrate` 会返回 `blocked`，不会执行写入。
- 所有维护入口输出 JSON，便于人工查看和 CI/脚本读取。

---

## 4. 后续收敛方向

后续可以继续减少直接执行旧工具文件的场景：

- `tools/backfill-*.mjs`、`tools/reconcile-*.mjs`、`tools/import-*.mjs`、`tools/export-*.mjs` 暂时保留为兼容模块。
- 新 workflow 和维护文档优先使用 `tools/training-maintenance.mjs`。
- `export markdown` 与 `import markdown` 后续仍可继续补充更严格的 dry-run/confirm 语义。
