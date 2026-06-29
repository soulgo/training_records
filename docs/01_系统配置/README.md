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
| 数据库连接 | `DEV_TRAINING_DB_URL` 映射为运行时 `TRAINING_DB_URL` | `TRAINING_DB_URL` |
| Telegram token | `DEV_TELEGRAM_BOT_TOKEN` 映射为运行时 `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` |
| COS | 当前 dev workflow 注入 `DEV_COS_*` 并映射为运行时 `COS_*` | 当前 `main` 分支 `sync.yml` 未注入 `COS_*` |

## 维护规则

1. 新增或删除 GitHub Secret/Variable 时，同时核对 `.github/workflows/*.yml`、`src/`、`tools/`、`cloudflare/`。
2. 新增或删除 Worker 变量时，同时核对 `wrangler.toml`、`wrangler.dev.toml` 和 `cloudflare/*.mjs`。
3. 不在文档中填写 Secret 明文。
4. `main.md` 必须用 `git show main:<path>` 重新核对后维护。
5. 如果代码只支持某个运行时 env，但 workflow 没有注入，应写成“代码支持，当前 workflow 未注入”，不能写成必配项。

## 修改配置注意事项

- `TRAINING_DB_URL`、`DEV_TRAINING_DB_URL` 影响 PostgreSQL 写入、读取、快照、备份和站点构建。
- `GITHUB_SYNC_WORKFLOW_FILE` 与 `GITHUB_SYNC_REF` 决定 Worker 触发哪条 Actions 链路，配错会把消息写到错误分支。
- `TELEGRAM_SECRET_TOKEN` 和 `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` 是 webhook 入口校验配置，配错会导致 Worker 拒绝请求。
- `COS_*` 只由同步 workflow 中的 Node 代码使用；Cloudflare Worker 不读取 COS Secret。
