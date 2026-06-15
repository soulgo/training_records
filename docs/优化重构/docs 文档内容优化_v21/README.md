# Goal Document: docs 文档内容优化 v21

## Go / No-Go

- **Judgment**: Go
- **Reason**: 最新代码已经把 main/dev 的 Telegram 与飞书入口收敛为统一 Worker 和统一 sync workflow；现有长期文档仍有独立 Telegram/飞书 Action、独立飞书 Worker、旧 wrangler 配置等口径，继续保留会误导后续维护。

## Target Outcome

`docs/` 下的长期维护文档要反映当前真实系统：Telegram 与飞书都先进入统一 Cloudflare Worker，再由 GitHub Actions 在 `sync.yml` 或 `sync-dev.yml` 内判断 channel，分别执行 `sync:telegram` 或 `sync:feishu`。GitHub Actions 与 Cloudflare 配置文档必须先列“需要配置的参数”，再解释参数用途和运行链路，旧的分散入口说明要删除或降级为历史背景。

## Goal Definition

- **Type**: quality / operational
- **Boundary**: 只修改 `docs/` 文档内容；不修改源码、workflow、测试或运行配置。
- **Non-goals**:
  - 不新增系统功能。
  - 不调整 `.github/workflows/*.yml`、`wrangler*.toml` 或 Worker 源码。
  - 不迁移数据库、不部署 Cloudflare、不刷新 webhook。
- **Deferred work**:
  - 如果后续要让生产 Pages 部署自动清 Cloudflare cache，应另开代码变更同步 workflow 与测试。
  - 历史阶段方案可继续留在 `docs/优化重构/`，本轮只保证长期入口文档不再引用旧方案作为当前事实。
- **Verification rule**: 文档中出现的 workflow、wrangler、Worker、Secrets/Variables 名称都能在当前代码或配置中找到；旧的 `telegram-sync.yml`、`feishu-sync.yml`、`wrangler.feishu.toml`、`deploy-cloudflare-feishu-worker.yml` 不再作为当前入口出现。
- **Evidence source**: `.github/workflows/sync.yml`、`.github/workflows/sync-dev.yml`、`.github/workflows/deploy-pages.yml`、`.github/workflows/deploy-cloudflare-pages-dev.yml`、`.github/workflows/deploy-cloudflare-worker.yml`、`.github/workflows/deploy-cloudflare-worker-dev.yml`、`wrangler.toml`、`wrangler.dev.toml`、`cloudflare/sync-dispatch-worker.mjs`、`cloudflare/telegram-sync-dispatch-worker.mjs`、`cloudflare/feishu-sync-dispatch-worker.mjs`、`package.json` scripts。
- **Pass criteria**: `rg` 检查不再在长期维护文档中把旧独立入口写成当前事实；`git diff --check -- docs` 通过；文档变更能以 docs-only commit 分别落到 `dev` 与 `main`。
- **Confidence note**: 代码和 workflow 是配置事实源；文档只做结构收敛和口径修正，不改变运行行为。
- **Judgment owner**: 代码对照检查、git diff 与用户验收。

## Current State

- `wrangler.toml` 和 `wrangler.dev.toml` 都指向 `cloudflare/sync-dispatch-worker.mjs`。
- 统一 Worker 通过 Telegram secret header、飞书 Lark headers 或飞书请求体结构判断 channel，再调用 Telegram 或 Feishu handler。
- `sync.yml` 监听 `telegram_update` 与 `feishu_update`，手动触发时用 `channel=telegram|feishu` 决定执行 `sync:telegram` 或 `sync:feishu`。
- `sync-dev.yml` 监听 `telegram_update_dev` 与 `feishu_update_dev`，同样在 workflow 内判断 channel。
- `deploy-pages.yml` 负责生产 GitHub Pages；`deploy-cloudflare-pages-dev.yml` 负责 dev Cloudflare Pages 预览。
- `deploy-cloudflare-worker.yml` 部署生产统一 Worker 并刷新生产 Telegram webhook；`deploy-cloudflare-worker-dev.yml` 部署 dev 统一 Worker 并刷新 dev Telegram webhook。
- 现有文档问题：
  - `系统总览.md` 仍把 `telegram-sync.yml`、`feishu-sync.yml`、`wrangler.feishu.toml`、独立飞书 Worker 写成当前事实。
  - `数据流转说明.md` 的 Mermaid 图仍显示 Telegram Worker 和 Feishu Worker 分别进入 `telegram-sync.yml / feishu-sync.yml`。
  - `飞书通道部署.md` 同时写了“已合并统一入口”和“生产使用独立 Worker”，口径冲突。
  - `GitHub与Cloudflare配置.md` 内容过长，参数散落在后半部分，不符合“先参数、后解释”的维护习惯。
  - `日常维护手册.md` 的 Worker 测试命令和 Cloudflare cache 说明需要贴合当前代码。

## Priority Rationale

- 先改部署配置主入口，因为这里最容易导致 Secrets、Variables 和 Worker 绑定填错。
- 再改系统总览和数据流转，统一维护者的心智模型。
- 最后改飞书部署、dev 清单、日常维护和 README 索引，减少重复说明。

## Assumptions and Open Decisions

| Item | Status | Impact | Owner / Next step |
| --- | --- | --- | --- |
| 本轮只改 docs | confirmed | 避免把已有未提交 workflow/test 变更混入文档提交 | 文档提交时只 stage `docs/` |
| 生产自动 Cloudflare cache purge | unresolved | 当前目标分支 workflow 尚未把 purge 作为已提交事实，文档不能写成必然自动行为 | 只写当前可验证的手动 purge；后续代码落地后再补文档 |
| 历史 `docs/优化重构/` 是否删除 | assumed deferred | 这些文件是阶段记录，删除风险大 | 本轮不删除历史方案，只让主入口不依赖旧方案 |
| dev/main 文档是否完全相同 | assumed | 用户要求两分支都提交同一轮 docs 优化 | 同一 patch 分别应用到 `dev` 与 `main` |

## Phases

### Phase 1: 方案和审计

- **Purpose**: 先把目标、边界、旧口径和验证规则写清楚。
- **Entry condition**: 已读取关键 workflow、wrangler 和 Worker 源码。
- **Phase rules**:
  - 只新增 v21 文档，不改长期手册。
  - 明确以代码为事实源。
- **Todos**:
  - [x] 写本目标文档。
    - **Surface**: `docs/优化重构/docs 文档内容优化_v21/README.md`
    - **Proof**: 文件存在且包含目标、范围、当前状态、阶段和验证规则。
    - **Depends on**: 代码读取。
- **Exit proof**: v21 目录存在并包含本 README。
- **Stop condition**: 如果发现 dev/main 代码不是统一入口，需要先重审目标。

### Phase 2: 配置主入口重构

- **Purpose**: 让 GitHub Actions 与 Cloudflare 配置文档第一屏就是要填的参数。
- **Entry condition**: Phase 1 完成。
- **Phase rules**:
  - 参数清单放在文档最前面。
  - 参数解释、运行链路、部署与验证放在后面。
  - 删除当前事实中不存在的独立入口说明。
- **Todos**:
  - [ ] 重写 `docs/部署维护/GitHub与Cloudflare配置.md`。
    - **Surface**: 部署维护文档。
    - **Proof**: 文档开头是 GitHub/Cloudflare 参数清单，后面才解释运行链路。
    - **Depends on**: Phase 1。
  - [x] dev 统一入口清单已在 v22 中删除，当前 dev 参数统一维护在 `docs/部署维护/GitHub与Cloudflare配置.md`。
    - **Surface**: dev 配置清单。
    - **Proof**: dev 参数由长期配置文档维护，旧 dev 资源只在已实施留痕中出现。
    - **Depends on**: 主入口文档。

### Phase 3: 系统心智模型修正

- **Purpose**: 把系统总览、数据流转、飞书部署和日常维护统一到“统一 Worker + 统一 Action 内判断 channel”的模型。
- **Entry condition**: Phase 2 完成。
- **Phase rules**:
  - Mermaid 图和表格不得再出现当前不存在的 workflow。
  - 飞书文档保留飞书开放平台参数，但不再描述独立飞书 Worker 为当前生产入口。
  - 日常维护只保留常用命令和当前测试命令。
- **Todos**:
  - [ ] 更新 `docs/系统架构/系统总览.md` 的 GitHub Actions、配置作用域、部署方式和自动化流程。
    - **Surface**: 系统架构文档。
    - **Proof**: 表格使用 `sync.yml` / `sync-dev.yml`，Worker 配置使用 `wrangler.toml` / `wrangler.dev.toml`。
    - **Depends on**: Phase 2。
  - [ ] 更新 `docs/数据流转/数据流转说明.md` 的消息通道图和说明。
    - **Surface**: 数据流转文档。
    - **Proof**: 图中只有统一 Worker 与统一 sync workflow。
    - **Depends on**: Phase 2。
  - [ ] 更新 `docs/部署维护/飞书通道部署.md`。
    - **Surface**: 飞书部署文档。
    - **Proof**: 参数总览在前，部署说明使用统一 Worker。
    - **Depends on**: Phase 2。
  - [ ] 更新 `docs/部署维护/日常维护手册.md` 和 `docs/README.md`。
    - **Surface**: 运维入口与索引。
    - **Proof**: 索引优先指向统一配置文档；日常手册不再建议旧独立入口。
    - **Depends on**: Phase 3 其它文档。

### Phase 4: 验证和分支提交

- **Purpose**: 确认文档没有明显格式错误，并把 docs-only 变更落到目标分支。
- **Entry condition**: Phase 3 完成。
- **Phase rules**:
  - 只 stage `docs/`。
  - 不回滚当前工作区已有非 docs 改动。
  - dev/main 各自独立 commit。
- **Todos**:
  - [ ] 运行 `git diff --check -- docs`。
    - **Surface**: 文档格式。
    - **Proof**: 命令退出 0。
    - **Depends on**: Phase 3。
  - [ ] 运行关键旧口径 `rg` 检查。
    - **Surface**: docs 搜索。
    - **Proof**: 长期维护文档不再把旧入口写成当前事实。
    - **Depends on**: Phase 3。
  - [ ] 提交到 `dev`。
    - **Surface**: Git branch `dev`。
    - **Proof**: `git log dev -1` 显示 docs commit。
    - **Depends on**: 验证通过。
  - [ ] 提交到 `main`。
    - **Surface**: Git branch `main`。
    - **Proof**: `git log main -1` 显示 docs commit。
    - **Depends on**: dev 提交完成。

## Dry-Run Findings

- 当前工作区已有非本轮修改的 `.github/workflows/deploy-pages.yml`、`test/github-workflows.test.mjs`、`CHANGELOG.md` 和部分 docs diff；提交时必须只纳入本轮 `docs/` 目标变更，避免混入代码变更。
- `origin/main` 比本地 `main` 新，正式提交前应以远端分支为基线准备 worktree 或更新本地分支。
- `origin/dev` 的 `deploy-pages.yml` 仍有旧路径引用，但本轮不改代码；文档只说明 dev Pages 预览的当前职责，不把该路径作为配置目标扩写。
- 长期文档中旧的 `wrangler.feishu.toml`、`deploy-cloudflare-feishu-worker.yml` 应从当前操作步骤中删除；历史优化方案中可保留。

## Final Validation

- `git diff --check -- docs`
- `rg -n "telegram-sync\\.yml|feishu-sync\\.yml|wrangler\\.feishu|deploy-cloudflare-feishu-worker|feishu-sync-dispatch-dev|telegram-sync-dispatch-dev" docs/README.md docs/系统架构 docs/数据流转 docs/部署维护`
- `git status --short` 确认 stage/commit 范围只有 docs。

## First Execution Step

重写 `docs/部署维护/GitHub与Cloudflare配置.md`，把参数清单前置，并以当前统一 Worker / 统一 sync workflow 为唯一当前部署口径。
