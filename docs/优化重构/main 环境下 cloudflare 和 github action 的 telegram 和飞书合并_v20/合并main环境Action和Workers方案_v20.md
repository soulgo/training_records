# v20 - 合并 main 环境 Telegram 和飞书的 GitHub Action 及 Cloudflare Workers

## Goal Document: main 统一同步入口

### Go / No-Go

- **Judgment**: Go
- **Reason**: dev 环境 v19 已验证统一 Worker + 统一 Sync workflow 的边界；main 现状仍是 Telegram / 飞书双 Worker、双同步 Action、双 deploy workflow，维护成本和配置漂移风险明确存在。

### Target Outcome

main 环境只保留一个 Cloudflare Worker 和一个同步 GitHub Action，由统一入口识别 Telegram / 飞书请求并派发到同一个 main workflow 内的分渠道同步步骤；旧生产 Telegram Worker、飞书 deploy workflow、Telegram/飞书独立 sync workflow 在验证后删除或停用。统一 Worker 复用既有 `feishu-sync-dispatch` 名称，以保留不可反读的飞书/GitHub Cloudflare secrets。

### Goal Definition

- **Type**: technical / operational
- **Boundary**: 合并 main 环境的 Cloudflare Worker、Wrangler 配置、GitHub sync workflow、Worker deploy workflow、测试与部署配置文档。
- **Non-goals**:
  - 不重写 Telegram / 飞书各自 handler 的认证、解密、缓冲和 GitHub dispatch 逻辑。
  - 不合并 dev Pages 或生产 Pages 部署链路。
  - 不删除 `cloudflare/telegram-sync-dispatch-worker.mjs` 和 `cloudflare/feishu-sync-dispatch-worker.mjs` 源文件；统一 Worker 仍复用它们。
- **Deferred work**:
  - 若后续要将 dev/main 配置抽象成生成脚本，可另开配置生成任务。
- **Verification rule**: 本地测试通过，Wrangler dry-run / deploy 成功，GitHub Actions 只保留统一 main sync 入口，Cloudflare 只保留统一 main Worker 入口。
- **Evidence source**: `node --test`、`npx wrangler deploy --dry-run`、`npx wrangler deploy`、`gh workflow list`、`npx wrangler deployments list` / Worker 列表。
- **Pass criteria**: `wrangler.toml` 指向 `feishu-sync-dispatch` + `cloudflare/sync-dispatch-worker.mjs`；`.github/workflows/sync.yml` 监听 `telegram_update` 和 `feishu_update`；旧 main sync/deploy workflow 文件删除；配置清单写明 GitHub/Cloudflare/Telegram/飞书最终值。
- **Confidence note**: dev v19 已覆盖统一入口 channel detection、body clone、双 Durable Object、分渠道 dispatch type；main 复用同一 Worker 源码，只替换生产资源名和事件类型。
- **Judgment owner**: 自动化测试 + 远程部署状态 + 用户对飞书/Telegram 端到端消息的最终验收。

### Current State

- main Telegram Worker: `telegram-sync-dispatch`，配置文件 `wrangler.toml`，入口 `cloudflare/telegram-sync-dispatch-worker.mjs`。
- main 飞书 Worker: `feishu-sync-dispatch`，配置文件 `wrangler.feishu.toml`，入口 `cloudflare/feishu-sync-dispatch-worker.mjs`，自定义域名 `feishu.soulgo.chat`。
- main Telegram sync workflow: `.github/workflows/telegram-sync.yml`，监听 `telegram_update`，并支持 `push` / `workflow_dispatch`。
- main 飞书 sync workflow: `.github/workflows/feishu-sync.yml`，监听 `feishu_update`，并支持 `workflow_dispatch`。
- dev 统一经验: `sync-dispatch-dev` + `.github/workflows/sync-dev.yml` 已保留两个 channel 的 summary、通知、失败 monitor 和 DB-only Pages dispatch 语义。

### Plan Rewrite Notes

| Existing item | Decision | Reason |
| --- | --- | --- |
| `sync-dispatch-dev` 统一 Worker 设计 | keep / rewrite | 复用 channel detection 和 `request.clone().json()` 约束，生产只换资源名和事件类型。 |
| `wrangler.dev.toml` 双 DO + 双 dispatch vars | rewrite | main 使用 `wrangler.toml`，目标 Worker 复用 `feishu-sync-dispatch`，dispatch type 为 `telegram_update` / `feishu_update`。 |
| `sync-dev.yml` 分渠道 workflow | keep / rewrite | 复用分渠道选择、summary、notify、failure monitor；main 额外保留 Telegram push / 手动场景的 `sync:db` 和 fast test 语义。 |
| 删除 dev 旧资源 | rewrite | main 删除旧生产 workflows / `wrangler.feishu.toml`，远程只删除 `telegram-sync-dispatch`；`feishu-sync-dispatch` 升级为统一 Worker。 |

### Drift Diagnosis

- **Goal drift**: 只改文档或只部署 Worker 不能证明 GitHub Action 也已合并，必须同时收敛 workflow。
- **Phase drift**: 先删旧资源会造成 webhook 中断；必须先部署统一入口、刷新 Telegram webhook、确认飞书 Request URL，再删旧 Worker。
- **Validation drift**: “文件已改”不等于线上生效；Cloudflare 和 GitHub 都需要远程状态证明。
- **Compatibility drift**: 不保留旧 dispatch type 别名；统一 Worker 分渠道发 `telegram_update` / `feishu_update`，统一 workflow 直接监听这两个生产事件。
- **Cleanup drift**: handler 源文件不是旧资源，不能删除；它们是统一 Worker 的内部模块。

### Priority Rationale

- 先用测试固定最终文件结构，避免 YAML/TOML 合并遗漏。
- 再部署升级后的 `feishu-sync-dispatch` 并刷新 Telegram webhook，确保新入口可接流量。
- 最后删除旧 workflow 文件和旧 Cloudflare Workers，减少中断窗口。

### Assumptions and Open Decisions

| Item | Status | Impact | Owner / Next step |
| --- | --- | --- | --- |
| main 统一 Worker 复用 `feishu-sync-dispatch` | confirmed | 保留既有飞书/GitHub Worker secrets，避免因 Cloudflare secrets 不可反读而阻塞远程配置 | 本方案执行 |
| 生产 Telegram webhook URL 使用 `https://feishu.soulgo.chat/telegram` | assumed | 复用现有飞书自定义域名，减少一个 public endpoint | 部署后更新 GitHub Variable 并刷新 webhook |
| 飞书生产 Request URL 使用 `https://feishu.soulgo.chat` | confirmed | 保持现有飞书开放平台配置语义 | 部署统一 Worker 后保存/验证 |
| Cloudflare / GitHub secrets 可读 | unresolved | GitHub 和 Cloudflare secret 值无法反读，只能复用已配置 secret 或由用户重填 | 本地/Actions 部署使用现有 secret；缺失项写入配置清单 |

## Final Architecture

合并后：

```text
Telegram Webhook -> feishu-sync-dispatch -> repository_dispatch(telegram_update) -> sync.yml -> npm run sync:telegram
飞书 Event       -> feishu-sync-dispatch -> repository_dispatch(feishu_update)   -> sync.yml -> npm run sync:feishu

deploy-cloudflare-worker.yml -> wrangler.toml -> feishu-sync-dispatch
refresh-telegram-webhook.yml -> TELEGRAM_WEBHOOK_URL=https://feishu.soulgo.chat/telegram
```

## Phases

### Phase 1: Test-contract first

- **Purpose**: 用自动化测试定义 main 最终入口数量和文件名。
- **Entry condition**: 当前分支从 `main` 派生且工作树干净。
- **Phase rules**:
  - 先写失败测试，再改 workflow / TOML。
  - 只覆盖生产统一入口，不调整业务同步逻辑。
- **Todos**:
  - [ ] 更新 `test/cloudflare-config.test.mjs`，要求 `wrangler.toml` 指向 `feishu-sync-dispatch` 并绑定两个 DO。
  - [ ] 更新 `test/github-workflows.test.mjs`，要求 `.github/workflows/sync.yml` 是 main 唯一同步入口。
- **Exit proof**: 相关测试先因缺少统一 main 配置失败。
- **Stop condition**: 如果测试揭示 main 缺少 v19 统一 Worker 源文件，先补回统一 Worker 源文件。

### Phase 2: Local implementation

- **Purpose**: 收敛本地生产配置。
- **Entry condition**: RED 测试已确认失败原因正确。
- **Phase rules**:
  - 复用 `cloudflare/sync-dispatch-worker.mjs`。
  - 保留 Telegram / 飞书 handler 源文件。
  - 删除旧 workflow 文件和 `wrangler.feishu.toml`，更新引用路径。
- **Todos**:
  - [ ] 修改 `wrangler.toml` 为统一 main Worker。
  - [ ] 新增 `.github/workflows/sync.yml`。
  - [ ] 修改 `.github/workflows/deploy-cloudflare-worker.yml` 的路径触发说明。
  - [ ] 删除 `.github/workflows/telegram-sync.yml`、`.github/workflows/feishu-sync.yml`、`.github/workflows/deploy-cloudflare-feishu-worker.yml`、`wrangler.feishu.toml`。
  - [ ] 更新 CI / Pages workflow 路径引用。
- **Exit proof**: 相关 tests green。
- **Stop condition**: 如果 workflow 语义无法同时保留 Telegram push/manual 和 Feishu dispatch/manual，则暂停拆分方案。

### Phase 3: Documentation

- **Purpose**: 给后续配置留下 main 版清单。
- **Entry condition**: 本地最终文件结构确定。
- **Phase rules**:
  - 配置文档只写最终态和操作顺序。
  - 明确哪些 secret 不能自动迁移。
- **Todos**:
  - [ ] 写 `main统一入口GitHub与Cloudflare配置清单.md`。
  - [ ] 更新 v20 方案中的执行结果和回退方案。
- **Exit proof**: v20 目录包含方案文档和配置清单。
- **Stop condition**: 如果远程状态与本地命名不同，先更新文档再部署。

### Phase 4: Remote rollout

- **Purpose**: 尽量完成 Cloudflare / GitHub 远程配置。
- **Entry condition**: 本地测试通过，Cloudflare / GitHub CLI 已认证。
- **Phase rules**:
  - 先部署升级后的 `feishu-sync-dispatch`，再刷新 Telegram webhook。
  - 旧 Worker 删除前必须确认统一 Worker 可响应。
  - 不尝试反读 secret 值。
- **Todos**:
  - [ ] `npx wrangler whoami` / `gh auth status`。
  - [ ] `npx wrangler deploy --dry-run`。
  - [ ] `npx wrangler deploy`。
  - [ ] 设置 GitHub Variable `TELEGRAM_WEBHOOK_URL=https://feishu.soulgo.chat/telegram`。
  - [ ] 运行或触发 `refresh-telegram-webhook.yml`。
  - [ ] 验证统一 Worker 405 / unknown_channel。
  - [ ] 删除旧 Cloudflare Worker `telegram-sync-dispatch`。
- **Exit proof**: 远程命令输出显示统一 Worker 已部署，旧 Workers 已删除或明确列为阻塞。
- **Stop condition**: 缺少认证、缺少 secret、分支保护阻止 workflow 文件落到 main，或统一入口验证失败。

## Dry-Run Findings

- `wrangler.feishu.toml` 删除后，所有测试和文档引用必须同步更新，否则 CI 会继续寻找旧文件。
- `.github/workflows/deploy-pages.yml` 和 `ci-tests.yml` 的 paths 需要从 `telegram-sync.yml` / `feishu-sync.yml` 改为 `sync.yml`。
- `refresh-telegram-webhook.yml` 不是旧同步入口，保留作为定时刷新兜底。
- 远程 secret 值无法从 GitHub / Cloudflare 读取；因此 main 统一 Worker 复用既有 `feishu-sync-dispatch`，并由 deploy workflow 自动补写 Telegram secrets。

## Final Validation

```bash
node --test test/cloudflare-config.test.mjs test/github-workflows.test.mjs test/sync-dispatch-worker.test.mjs test/telegram-sync-dispatch-worker.test.mjs test/feishu-dispatch-worker.test.mjs
npm test
npx wrangler deploy --dry-run
```

远程验证：

```bash
curl -i https://feishu.soulgo.chat/telegram
curl -i https://feishu.soulgo.chat
curl -i -X POST https://feishu.soulgo.chat/ -H 'content-type: application/json' --data '{"hello":"world"}'
```

预期：GET 返回 `405 method_not_allowed`，未知 POST 返回 `400 unknown_channel`。

## First Execution Step

先更新测试，确认 RED：当前 main 生产配置仍指向 `telegram-sync-dispatch` / `feishu-sync-dispatch`，缺少 `.github/workflows/sync.yml`，测试应失败。

## Execution Result - 2026-06-15

### Completed

- 本地已从 `main` 创建 `codex/main-unified-sync` 分支并完成实现。
- 已新增 `.github/workflows/sync.yml`，远端 GitHub Actions 已出现 `Sync (Main)`。
- 已删除远端 main 当前 workflow 文件中的旧生产入口：
  - `.github/workflows/telegram-sync.yml`
  - `.github/workflows/feishu-sync.yml`
  - `.github/workflows/deploy-cloudflare-feishu-worker.yml`
- 已删除仓库中的 `wrangler.feishu.toml`，`wrangler.toml` 已改为统一 Worker `sync-dispatch`。
- 已把 `.github/workflows/deploy-cloudflare-worker.yml` 改为只支持手动 `workflow_dispatch`，避免缺少 Cloudflare runtime secrets 时自动切流。
- 已写入配置清单：`main统一入口GitHub与Cloudflare配置清单.md`。
- 已更新部署维护文档顶部指针和飞书当前链路，提示 main 以 v20 清单为准。

### Verification Evidence

RED：

```bash
node --test test/cloudflare-config.test.mjs test/github-workflows.test.mjs
```

观察到正确失败：`wrangler.toml` 仍是 `telegram-sync-dispatch`、`wrangler.feishu.toml` 仍存在、`.github/workflows/sync.yml` 缺失、CI/Pages paths 仍指向旧 workflow。

GREEN：

```bash
node --test test/cloudflare-config.test.mjs test/github-workflows.test.mjs
node --test test/cloudflare-config.test.mjs test/github-workflows.test.mjs test/sync-dispatch-worker.test.mjs test/telegram-sync-dispatch-worker.test.mjs test/feishu-dispatch-worker.test.mjs
npm test
npx wrangler deploy --dry-run --config wrangler.toml
```

结果：

- 目标 workflow/config 测试：29/29 通过。
- 统一 Worker 相关测试：59/59 通过。
- 全量测试：458/458 通过。
- Wrangler dry-run 通过，识别到 `TELEGRAM_ALBUM_BUFFER`、`FEISHU_IMAGE_BUFFER`、`GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM=telegram_update`、`GITHUB_DISPATCH_EVENT_TYPE_FEISHU=feishu_update`。

远端 GitHub：

- 已推送到 `main`：
  - `7d7bae2 chore: unify main sync worker and workflows`
  - `477bcc7 chore: require manual main worker deploy`
- `gh workflow list --all` 显示 `Sync (Main)` active，旧 production `Telegram Sync`、`Feishu Sync`、`Deploy Cloudflare Feishu Worker` 不再显示。
- `gh api repos/soulgo/training_records/contents/.github/workflows?ref=main` 只列出 `sync.yml`、`sync-dev.yml` 和其它保留 workflow。
- follow-up 的远端 CI run `27522928715` 成功。

### Cloudflare Remote Status

已完成：

- `npx wrangler whoami` 已确认 Cloudflare OAuth 登录且具备 Workers write 权限。
- 旧 Worker secret 名称已确认：
  - `telegram-sync-dispatch`: `GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_SECRET_TOKEN`
  - `feishu-sync-dispatch`: `GITHUB_TOKEN`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`
- GitHub Variable `TELEGRAM_WEBHOOK_URL` 仍保持旧值 `https://telegram-sync-dispatch.1406221797.workers.dev/`，没有切到缺 secret 的新入口。

未完成：

- `sync-dispatch` 没有保留在 Cloudflare 上，因为新 Worker 没有任何 runtime secrets。
- 旧 Cloudflare Workers 暂未删除：
  - `telegram-sync-dispatch`
  - `feishu-sync-dispatch`

安全回滚记录：

- 第一次推送 main 后，GitHub 自动触发了一次旧版 `Deploy Cloudflare Worker` run `27522799967`，它创建了无 secrets 的 `sync-dispatch`。
- 为避免生产飞书入口损坏，已临时恢复旧 `wrangler.feishu.toml` 并重新部署 `feishu-sync-dispatch`，把 `feishu.soulgo.chat` 切回旧飞书 Worker。
- 已删除无 secrets 的 `sync-dispatch`。
- 当前验证 `https://feishu.soulgo.chat/` 返回 `405 method_not_allowed`，旧飞书 Worker 已重新接管自定义域名。

### Remaining Manual Step

Cloudflare Worker Secrets 不能反读，所以无法自动把两个旧 Worker 的 secrets 合并到新 `sync-dispatch`。要完成 Cloudflare 统一入口，需要手动或通过安全环境变量向新 Worker 写入：

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.toml
npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler.toml
npx wrangler secret put FEISHU_ENCRYPT_KEY --config wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config wrangler.toml
```

之后再按清单执行：

1. 手动运行 `Deploy Cloudflare Worker` 或本地执行 `npx wrangler deploy --config wrangler.toml`。
2. 将 GitHub Variable `TELEGRAM_WEBHOOK_URL` 改为 `https://feishu.soulgo.chat/telegram`。
3. 运行 `Refresh Telegram Webhook`。
4. 验证 Telegram 和飞书都触发 `Sync (Main)`。
5. 删除旧 Cloudflare Workers `telegram-sync-dispatch` 和 `feishu-sync-dispatch`。
