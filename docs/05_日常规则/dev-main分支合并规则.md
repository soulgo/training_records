# dev-main 分支合并规则

本文定义 `dev` 与 `main` 日常合并时的数据隔离规则。目标是只合并代码、配置结构和文档事实，不把一个环境的运行数据覆盖到另一个环境。

## 1. 环境边界

| 维度 | dev | main |
| --- | --- | --- |
| 分支 | `dev` | `main` |
| 数据库连接 | `DEV_TRAINING_DB_URL` 映射为运行时 `TRAINING_DB_URL` | `TRAINING_DB_URL` |
| Telegram Bot | `DEV_TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` |
| Telegram webhook | `DEV_TELEGRAM_WEBHOOK_URL` | `TELEGRAM_WEBHOOK_URL` |
| 飞书应用 | `DEV_FEISHU_APP_ID` / `DEV_FEISHU_APP_SECRET` | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| COS 图片存储 | `DEV_COS_*` | `COS_*` |
| Worker 配置 | `wrangler.dev.toml` | `wrangler.toml` |
| 同步 workflow | `.github/workflows/sync-dev.yml` | `.github/workflows/sync.yml` |

`dev` 数据和 `main` 数据是两套独立事实源。任一方向合并时，都不能把源分支的数据文件、数据库连接、bot token、webhook 地址、飞书应用、COS bucket/domain 当作目标环境的新值覆盖过去。

## 2. 禁止覆盖的数据范围

合并 `dev -> main` 或 `main -> dev` 时，以下内容必须按目标环境保留：

| 范围 | 规则 |
| --- | --- |
| PostgreSQL 数据 | 不用源分支的数据库导出、连接串或快照覆盖目标环境。 |
| Telegram 数据 | 不用源分支 bot、chat 白名单、webhook secret、webhook URL 覆盖目标环境。 |
| 飞书数据 | 不用源分支 app id、app secret、chat 白名单、事件订阅配置覆盖目标环境。 |
| COS 图片数据 | 不用源分支 bucket、domain、path prefix 覆盖目标环境。 |
| 生成内容 | 不把源分支同步产生的 `训练记录.md`、`source/_posts/`、`source/images/` 作为默认合并内容覆盖目标环境。 |
| GitHub Settings | 不为了合并而把 `DEV_*` 改成生产变量，也不把生产变量改成 `DEV_*`。 |
| Cloudflare Worker Secrets | 不跨环境复用 `TELEGRAM_SECRET_TOKEN`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`、`GITHUB_TOKEN` 的实际值。 |

如果确实要迁移某条业务数据，必须把它当作单独的数据迁移任务处理，先写清楚来源、目标、范围、回滚方式和验收方式，不能夹在日常代码合并里。

## 3. dev 合并到 main

`dev -> main` 的目标是把已经验证过的代码、workflow 结构、配置结构和当前系统文档发布到生产分支。

合并前必须检查：

1. `git diff main...dev -- .github/workflows wrangler.toml wrangler.dev.toml docs src tools cloudflare sql package.json package-lock.json`
2. 确认 `.github/workflows/sync.yml` 仍使用生产变量：`TRAINING_DB_URL`、`TELEGRAM_BOT_TOKEN`、`FEISHU_APP_ID`、`COS_*`。
3. 确认 `.github/workflows/sync-dev.yml` 仍使用 dev 变量：`DEV_TRAINING_DB_URL`、`DEV_TELEGRAM_BOT_TOKEN`、`DEV_FEISHU_APP_ID`、`DEV_COS_*`。
4. 确认 `wrangler.toml` 仍指向生产 Worker：`feishu-sync-dispatch`、`feishu.soulgo.chat`、`GITHUB_SYNC_REF=main`。
5. 确认 `wrangler.dev.toml` 仍指向 dev Worker：`sync-dispatch-dev`、`feishu-dev.soulgo.chat`、`GITHUB_SYNC_REF=dev`。
6. 对 `训练记录.md`、`source/_posts/`、`source/images/` 的变更逐项确认；默认不从 dev 覆盖 main。

允许合并：

- 业务代码、测试、SQL schema 变更。
- workflow 的通用逻辑修复。
- `wrangler` 的结构性变更，但必须保留各自环境名称、route、dispatch type 和 sync ref。
- 当前系统文档更新。

禁止直接合并：

- dev 同步产生的数据内容覆盖 main。
- dev 专用域名、bot、飞书应用、COS bucket/domain 覆盖 main。
- 只在 dev 验证用的临时变量、调试开关、测试数据。

## 4. main 合并到 dev

`main -> dev` 的目标是让开发分支拿到生产分支已经稳定的代码和文档基线，但不能把生产数据覆盖到 dev。

合并前必须检查：

1. 生产数据文件变更是否会覆盖 dev 正在验证的数据。
2. `sync-dev.yml`、`deploy-cloudflare-pages-dev.yml`、`deploy-cloudflare-worker-dev.yml` 是否仍保留 dev 变量。
3. `wrangler.dev.toml` 是否仍保留 dev Worker 名称、route 和 `GITHUB_SYNC_REF=dev`。
4. dev 的数据库、Telegram、飞书、COS 设置是否仍独立。

允许合并：

- 已在 main 稳定的 bugfix、测试、文档修复。
- 当前系统文档的事实更新。
- 通用 workflow 修复，但不能把生产变量名替换进 dev workflow。

禁止直接合并：

- main 同步产生的数据内容覆盖 dev。
- 生产 bot、飞书应用、COS bucket/domain、webhook URL 覆盖 dev。
- 生产专用的 cache purge、站点域名或 webhook 设置覆盖 dev 验证入口。

## 5. 冲突处理规则

出现冲突时按这个顺序处理：

1. 代码冲突：按功能正确性解决，并跑相关测试。
2. workflow 冲突：先保留目标环境变量名，再合并通用逻辑。
3. `wrangler` 冲突：先保留目标环境 Worker name、route、dispatch type、sync ref，再合并结构变更。
4. 文档冲突：当前事实写入 `docs/01_系统配置/`、`docs/02_系统核心逻辑/`、`docs/04_问题与排查/`；历史背景通过 Git 历史和 CHANGELOG 追溯，不保留第二套历史文档。
5. 数据冲突：默认保留目标分支数据；需要迁移时单独开迁移任务。

## 6. 合并后验收

合并完成后至少检查：

1. `git diff` 中没有把 `DEV_*` 写进 main 的生产入口，也没有把生产变量写进 dev 的开发入口。
2. `wrangler.toml` 和 `wrangler.dev.toml` 的 Worker 名称、route、`GITHUB_SYNC_REF` 正确。
3. `docs/01_系统配置/dev.md` 和 `docs/01_系统配置/main.md` 仍分别描述各自环境。
4. 如涉及同步链路，分别手动触发目标环境 workflow 验证。
5. 如涉及数据文件，确认目标环境数据没有被源分支批量覆盖。
