# 低优先级：Markdown 迁移与备份治理

> 优先级：低  
> 目标：在 PostgreSQL 安全和性能优化完成后，逐步把本地 Markdown 从“常规存储/构建中间态”降级为“数据库导出的可审计备份”和“显式人工恢复入口”。

## 当前证据

| 事实 | 证据 |
| --- | --- |
| `package.json` 仍提供 `export:markdown`、`import:markdown`、`reconcile:markdown`、`sync:db`。 | `package.json:13-20` |
| 查询展示逻辑仍支持 `TRAINING_SNAPSHOT_SOURCE=markdown/database`；默认未设置时是 `markdown`。 | `docs/02_系统核心逻辑/查询展示逻辑.md:30-34`、`tools/generate-training-data.mjs`、`src/domain/training/training-snapshot.mjs` |
| site-build 严格 DB 快照时先 `npm run export:markdown`，然后把 `TRAINING_SNAPSHOT_SOURCE` 改成 `markdown` 再构建。 | `.github/actions/site-build/action.yml:114-128` |
| Markdown Backup workflow 从 DB 导出 Markdown，并可提交 `训练记录.md source/_posts source/images`。 | `.github/workflows/markdown-backup.yml:18-28`、`.github/workflows/markdown-backup.yml:82-105` |
| `exportDerivedTrainingMarkdown()` 会写 `训练记录.md`，并重建 derived thought posts。 | `tools/export-training-markdown.mjs:18-51`、`tools/export-training-markdown.mjs:129-168` |
| `syncTrainingCore` 的 markdown phase 会调用 `reconcileTrainingMarkdownToCore()`，并通过 `importTrainingMarkdownToDatabase()` 写回 DB。 | `tools/sync-training-core.mjs:159-184` |
| `training-maintenance sync` 已支持 `--dry-run`，`maintenance:migrate` 已支持 `--dry-run` / `--confirm`。 | `tools/training-maintenance.mjs:651-760` |
| 行为文档已经要求 Markdown 导入属于 legacy 修复阶段，生产写入前先 dry-run 并核对 affected days。 | `docs/02_系统核心逻辑/Action日志与失败补偿.md:85-109` |
| `core.thought.markdown_path` 仍是兼容层路径，SQL 注释明确其是当前 Markdown 兼容层。 | `sql/training_records/core.sql:173-186` |

## 迁移原则

1. PostgreSQL 的 `core.*` 是当前业务事实源；`ingest.*` 用于追溯消息、AI 识别和 pending；`archive.*` 用于历史 Markdown 解析归档和恢复材料。
2. Markdown 导出可以自动化，Markdown 导入必须显式、可 dry-run、可审计。
3. 不允许把 Markdown fallback 成功误报为 database 成功。
4. 清理 Markdown 依赖前，必须先完成高优先级安全收敛和中优先级读取性能优化。

## 分阶段目标

### 阶段 A：明确 Markdown 只读/备份边界

状态：短期最可落地。

- `export:markdown` 保留为 DB -> Markdown 备份。
- `import:markdown` / `reconcile:markdown` 保留为人工恢复入口。
- `sync:db` 默认 safe 阶段不应自动运行 markdown phase；需要 markdown phase 时必须显式传 `--phase markdown` 或 `--phase all`。
- Action summary 和文档中继续强调：Markdown 导入会 whole-day replacement，不能当作普通增量同步。

代码任务：

- [ ] 在 `tools/training-maintenance.mjs sync --phase markdown` 输出中强制展示 `dryRun`、affected days、差异摘要。
- [ ] 对非 dry-run markdown phase 增加二次确认机制，例如 `--confirm` 或仅允许 `maintenance:migrate --confirm` 调用。
- [ ] `docs/04_问题与排查/PostgreSQL.md` 增加“Markdown 导入风险”小节。

### 阶段 B：站点构建直接消费 DB 快照

状态：需要先完成读取性能优化。

当前 site-build 是“严格 DB -> 导出 Markdown -> 切换为 Markdown 构建”。目标是：

- `TRAINING_SNAPSHOT_SOURCE=database` 时，`npm run build:data` 直接读取 PostgreSQL 生成站点数据。
- `source/_posts` 随想页面如果仍由 Hexo 读取 Markdown，则只由 export step 作为页面兼容层生成，不再被当作事实源。
- 若 DB 快照失败，构建应失败或明确标记为 `strict_db_error`，不能静默 fallback。

代码任务：

- [ ] 梳理 Hexo generators 当前是否依赖 `source/_posts` 而非 `snapshot.thoughts`。
- [ ] 让随想页面优先从 DB snapshot/view model 生成，减少 `source/_posts` 对构建的必要性。
- [ ] site-build 中 `Export database markdown for Hexo posts` 改成可选兼容步骤，默认不再改变 `TRAINING_SNAPSHOT_SOURCE`。
- [ ] 为 `TRAINING_SNAPSHOT_STRICT_DATABASE=true` 增加测试，验证 DB 失败不会 fallback 为 Markdown 成功。

### 阶段 C：Markdown Backup 变成纯备份

状态：低风险，但要先稳定阶段 A。

- `Markdown Backup` workflow 继续按 `MARKDOWN_BACKUP_ENABLED`、`MARKDOWN_BACKUP_FREQUENCY`、`MARKDOWN_BACKUP_BRANCH`、`MARKDOWN_BACKUP_COMMIT` 运行。
- 备份分支只接受 DB 导出的派生文件。
- 不允许在备份分支手工编辑后再自动导入 DB；人工恢复必须走 `maintenance:sync --phase markdown --dry-run` -> 审核 -> confirm。

代码任务：

- [ ] Backup summary 中保留 `changed`、`commit enabled`、`alert`，并补充 DB snapshot source。
- [ ] 导出失败不得覆盖旧 `训练记录.md` 或旧 thought posts；当前 export 会直接写文件，后续可先写临时目录，通过后再替换。
- [ ] 增加 backup 恢复演练文档：从某次备份定位目标日期，但最终恢复仍以 DB 审核命令为入口。

### 阶段 D：清理 Markdown 常规存储表述

状态：最后阶段。

- `package.json.description` 当前仍是 `Hexo dashboard for Markdown-based training records`，要等 DB 构建稳定后再改。
- README 和系统文档中把 Markdown 定位改为“备份/导出格式/人工恢复材料”。
- 若不再需要本地 Markdown 构建，清理或归档相关脚本时必须保留恢复路径说明。

## 具体改动点

| 模块 | 当前职责 | 后续改法 |
| --- | --- | --- |
| `tools/export-training-markdown.mjs` | DB -> `训练记录.md` 和 `source/_posts` | 保留，但改成原子写入：先临时目录，成功后替换。 |
| `tools/reconcile-training-markdown-to-core.mjs` | Markdown -> DB 对账 | 默认 dry-run；非 dry-run 要 confirm，并输出 affected days。 |
| `tools/sync-training-core.mjs` | safe/all/archive/ingest/markdown/thoughts phase | markdown phase 与 safe phase 继续隔离，禁止隐式运行。 |
| `.github/actions/site-build/action.yml` | 严格 DB 时先导出 Markdown 再构建 | 阶段 B 后改为直接 DB build；Markdown export 只服务 Hexo 兼容层。 |
| `.github/workflows/markdown-backup.yml` | 定时导出并提交 Markdown | 保留为备份，不承担事实源写入。 |
| `sql/training_records/core.sql` | `core.thought.markdown_path` 兼容字段 | 保留一轮，用于定位旧页面路径；长期可转为 nullable legacy 字段。 |

## 审计 Checklist

### 阶段 A

- [ ] `npm run sync:db` 默认不运行 markdown phase。
- [ ] `npm run maintenance:sync -- --phase markdown --dry-run` 输出 affected days。
- [ ] 非 dry-run Markdown 导入必须有明确确认参数。
- [ ] Markdown 导入失败不应修改 DB。

### 阶段 B

- [ ] `TRAINING_SNAPSHOT_SOURCE=database` 下 `npm run build:data` 不依赖刚导出的 `训练记录.md`。
- [ ] DB 不可用时，严格 DB 构建失败并在日志中出现 database/strict_db 语义。
- [ ] 页面 `/`、`/thoughts/`、`/misc/`、`/body-feedback/` 均能从 DB 派生数据构建。
- [ ] 构建过程中没有把旧 Markdown 内容写回 DB。

### 阶段 C

- [ ] `Markdown Backup` 手动运行成功，summary 显示 Gate、Frequency、Branch、Changed、Alert。
- [ ] `MARKDOWN_BACKUP_COMMIT=false` 且有变化时会产生 warning，而不是静默丢弃。
- [ ] 导出失败不会覆盖旧备份文件。

### 阶段 D

- [ ] README、`package.json.description`、系统配置文档不再把 Markdown 描述为主存储。
- [ ] 所有保留的 Markdown 命令都标注为 backup/recovery。
- [ ] 删除任何 Markdown 常规存储依赖前，已有 DB 备份和恢复演练记录。

## 回滚策略

- 阶段 B 若 DB 直接构建失败，先恢复 site-build 的“导出 Markdown 再构建”兼容路径。
- 阶段 C 若原子导出有 bug，先回退到旧 export，但保留“导出失败不得提交”的 workflow gate。
- 阶段 D 不做硬删除；先把命令标记 legacy，稳定一轮后再清理。
