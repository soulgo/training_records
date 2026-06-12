# 数据库唯一事实源与 Markdown 备份方案

## 背景问题

当前页面数据已经可以从 PostgreSQL `core.*` 读取，但部署和维护链路里仍存在 Markdown 回灌数据库的动作。`npm run sync:db` 过去默认包含 Markdown 对账；当 `训练记录.md` 缺少 Telegram 图片解析后直接写入数据库的新数据时，对账会按日期重写 `core.measurement`、`core.activity`、`core.meal`、`core.sleep`，导致页面在部署后看起来丢失部分记录。

新的数据边界是：数据库是唯一事实源，Markdown 是数据库派生出来的人工可读备份。

## 目标架构

- 训练、体脂秤、饮食、睡眠图片解析结果直接写入 PostgreSQL。
- 随想和身体反馈以 `core.thought` 为准，Markdown 文章只作为备份和静态内容导出产物。
- 页面、分析和 MCP 查询优先读取数据库快照；生产 DB-only 部署使用严格数据库模式，读库失败不发布旧 Markdown 页面。
- Markdown 不再在部署前自动回灌数据库；只有显式人工维护命令才允许 Markdown 导入。

## 写入策略

Telegram 图片正常成功路径写入 `ingest.*` 审计层后，按批次内容增量 upsert：

| 模块 | 主表 | 写入规则 |
| --- | --- | --- |
| 体脂秤 | `core.measurement` | 按日期、测量时间、体重生成稳定 key，upsert 本批次测量 |
| 运动 | `core.activity` | 按日期、时间、类型、详情生成稳定 key，upsert 本批次活动 |
| 饮食 | `core.meal` | 按日期、餐次名、热量生成稳定 key，upsert 本批次餐次 |
| 睡眠 | `core.sleep` | 按日期、睡眠类型、入睡、醒来、总分钟生成稳定 key，upsert 本批次睡眠 |
| 随想/身体反馈 | `core.thought` | 按 Telegram message id upsert 或软删除 |

同一天缺少某个模块时，不删除该模块历史数据。`core.training_day` 只刷新汇总字段，例如活动数、总时长、训练热量、摄入热量和饮食明细。

## 同步边界

- `npm run sync:db`：默认安全同步，只执行 archive 回填、ingest 睡眠修复和 thoughts 同步，不执行 Markdown -> DB。
- `npm run import:markdown` / `npm run reconcile:markdown`：保留为显式人工维护入口。执行前必须确认 Markdown 是要覆盖数据库的可信快照。
- `npm run export:markdown`：严格从数据库导出 `训练记录.md`。数据库快照不可用时失败，不回退旧 Markdown。
- 部署 workflow 只运行安全同步和构建，不再执行 Markdown 对账或导出。

## 定时备份

`.github/workflows/markdown-backup.yml` 使用固定 cron 每天唤醒，再读取 GitHub Settings Variables 决定是否真正执行：

| Variable | 默认 | 说明 |
| --- | --- | --- |
| `MARKDOWN_BACKUP_ENABLED` | `false` | 是否启用定时 DB -> Markdown 备份 |
| `MARKDOWN_BACKUP_FREQUENCY` | `weekly` | `weekly` 或 `daily`；weekly 只在 UTC 周一执行 |
| `MARKDOWN_BACKUP_BRANCH` | `main` | 备份提交目标分支，dev 环境可设为 `dev` |
| `MARKDOWN_BACKUP_COMMIT` | `true` | 是否自动提交导出的 Markdown |

GitHub Actions 的 cron 不能直接由 Variables 动态修改，所以频率控制在 job 内完成。手动 `workflow_dispatch` 会绕过 enabled/frequency 门禁，方便临时备份。

## 验收标准

- 部署 workflow 不出现 Markdown -> DB 对账步骤。
- 图片批次入库测试中不出现 `delete from core.measurement/activity/meal/sleep`。
- `npm run export:markdown` 的默认数据源是数据库，数据库失败时直接失败。
- 定时备份 workflow 只有在 GitHub Variables 开启后才提交 `训练记录.md`、`source/_posts` 或 `source/images` 的备份变化。
- Dev 环境可用 `MARKDOWN_BACKUP_BRANCH=dev` 单独验证，不影响生产备份。
