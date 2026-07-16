# 系统配置目录

本目录只记录仓库源码、GitHub Actions、Wrangler 配置和运行代码能够证明的配置事实。平台控制台中的 Secret 实际值不能从仓库反读，因此本文档只记录变量名、配置位置、读取位置、使用代码和功能影响。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `dev.md` | 当前 `dev` 工作区的开发环境配置，来源于 `wrangler.dev.toml`、`.github/workflows/*dev*.yml`、`src/`、`tools/`、`cloudflare/`。 |
| `main.md` | `main` 分支对应的生产配置，来源于 `git show main:<path>` 能看到的配置和当前源码中通用读取逻辑。不得复制 dev 配置。 |

## dev 与 main 的区别

| 维度 | dev | main |
| --- | --- | --- |
| 分支 | `dev` | `main` |
| 同步 workflow | `.github/workflows/sync-dev.yml` | `main:.github/workflows/sync.yml` |
| Worker 配置 | `wrangler.dev.toml` | `main:wrangler.toml` |
| Worker 名称 | `sync-dispatch-dev` | `feishu-sync-dispatch` |
| GitHub dispatch type | `telegram_update_dev` / `feishu_update_dev` | `telegram_update` / `feishu_update` |
| GitHub sync ref | `dev` | `main` |
| 数据库连接 | GitHub Secret `DEV_TRAINING_DB_URL` 使用 `training_writer` 连接 dev 库并映射为运行时 `TRAINING_DB_URL`；`DEV_TRAINING_DB_READONLY_URL` 提供 dev 只读连接 | GitHub Secret `TRAINING_DB_URL` 使用同一个 `training_writer` 账号连接 main 库；`TRAINING_DB_READONLY_URL` 提供 main 只读连接 |
| Action 监控写库 | `Action Monitor Report` 按被监控 run 的 dev 分支选择 `DEV_TRAINING_DB_URL` 写入 dev `monitor.*` | `Action Monitor Report` 按 main 分支选择 `TRAINING_DB_URL` 写入 main `monitor.*` |
| Action 监控兜底 URL | 可选 `GITHUB_ACTION_MONITOR_REPORT_URL_DEV`，未填且 DB URL 不可用时跳过上报 | 可选 `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN`，未填且 DB URL 不可用时跳过上报 |
| Telegram token | `DEV_TELEGRAM_BOT_TOKEN` 映射为运行时 `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` |
| COS | 当前 dev workflow 注入 `DEV_COS_*` 并映射为运行时 `COS_*` | 当前 `main` workflow 注入 `COS_*` 并映射为运行时同名变量 |

## 维护规则

1. 新增或删除 GitHub Secret/Variable 时，同时核对 `.github/workflows/*.yml`、`src/`、`tools/`、`cloudflare/`，并确认 GitHub Settings 实际存在该项。
2. 新增或删除 Worker 变量时，同时核对 `wrangler.toml`、`wrangler.dev.toml` 和 `cloudflare/*.mjs`。
3. 不在文档中填写 Secret 明文。
4. `main.md` 必须用 `git show main:<path>` 重新核对后维护。
5. 如果代码只支持某个运行时 env，但 workflow 没有注入，应写成“代码支持，当前 workflow 未注入”，不能写成必配项。
6. GitHub Actions 的 Repository Secret/Variable 与 Cloudflare Worker Secret 是两套独立配置；同名或近似名称不能互相替代。

## 修改配置注意事项

- `TRAINING_DB_URL`、`DEV_TRAINING_DB_URL` 都由 GitHub Settings/Secrets 提供，URL 中的写账号固定为 `training_writer`；两个 Secret 分别指向 main/dev 数据库。`TRAINING_DB_READONLY_URL` / `DEV_TRAINING_DB_READONLY_URL` 同样由 GitHub Settings/Secrets 提供，并优先用于对应 workflow 的快照、导出、巡检、一致性检查和站点构建。源码不硬编码只读用户名；`Markdown Backup` 的提交目标分支由 `MARKDOWN_BACKUP_BRANCH` 决定，但其导出数据源固定为生产 `TRAINING_DB_*`，不能据目标分支推断数据源。
- Action 监控默认复用分支 PostgreSQL 连接写入 `monitor.*`；外部 `GITHUB_ACTION_MONITOR_REPORT_URL*` 只在分支 DB URL 不可用时作为 HTTP 兜底。
- `GITHUB_SYNC_WORKFLOW_FILE` 与 `GITHUB_SYNC_REF` 决定 Worker 触发哪条 Actions 链路，配错会把消息写到错误分支。
- `TELEGRAM_SECRET_TOKEN` 和 `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` 是 webhook 入口校验配置，配错会导致 Worker 拒绝请求。
- `COS_*` 只由同步 workflow 中的 Node 代码使用；Cloudflare Worker 不读取 COS Secret。

## GitHub Settings 同步状态（2026-07-16）

以下状态以当前 `origin/dev` 工作流和 GitHub Actions Repository Settings 的实际清单交叉核对为准：

- 已确认可从 GitHub Actions Repository Settings 删除的 14 项：`DEV_GITHUB_TOKEN`、`STANDBY_AI_API_KEY`、`STANDBY_AI_BASE_URL`、`STANDBY_AI_GEMINI_AUTH_MODE`、`STANDBY_AI_MODEL`、`STANDBY_AI_PROVIDER`、`STANDBY_AI_SUPPORTS_JSON_OBJECT`、`STANDBY_AI_SUPPORTS_JSON_SCHEMA`、`STANDBY_AI_SUPPORTS_TEXT_JSON`、`STANDBY_AI_TIMEOUT_MS`、`STANDBY_API_PROTOCOL`、`AI_RECOGNITION_SUPPORTS_JSON_OBJECT`、`AI_RECOGNITION_SUPPORTS_JSON_SCHEMA`、`AI_RECOGNITION_SUPPORTS_TEXT_JSON`。它们没有被当前 workflow 或运行时代码读取。
- 不要把上面的 `DEV_GITHUB_TOKEN` 与 Cloudflare Worker 的 `GITHUB_TOKEN` 混淆：后者仍是 Worker 调用 GitHub Actions API 所需的 Cloudflare Secret。
- 当前 workflow 仍引用、但在本次 GitHub Settings 清单中缺失的项，不能按“可删除”处理；应补齐或从 workflow 移除。优先核对 `DEV_TRAINING_DB_READONLY_URL`、`TRAINING_DB_READONLY_URL`，其余包括 `AI_PROVIDER`、`AI_OCR_ENABLED`、`AI_OCR_FAILURE_MODE`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_FALLBACK_API_KEY`、`TELEGRAM_RECOGNITION_FALLBACK_BASE_URL`、`TRAINING_ANALYSIS_GOAL`、`CLOUDFLARE_PAGES_DEV_PROJECT_NAME`、`MARKDOWN_BACKUP_COMMIT` 和 `GITHUB_ACTION_MONITOR_REPORT_URL*`。
