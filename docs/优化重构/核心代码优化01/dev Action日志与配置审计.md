# dev Action 日志与配置审计

> 审核时间：2026-06-18  
> 项目：`soulgo/training_records`  
> 审核范围：最新 10 次 GitHub Actions、dev 分支最近 10 次 GitHub Actions、仓库 Variables/Secrets 名称、`wrangler*.toml`、`sync*.yml`、飞书/Telegram Worker 与同步适配代码  
> 数据来源：`gh run list --limit 10`、`gh run list --branch dev --limit 10`、`gh run view --log`、`gh variable list`、`gh secret list`、`npm audit --json`、本地源码

## 审核结论

- **结论**：有条件通过
- **汇总**：P0:0 P1:8 P2:3 P3:1 待证据补充:1
- **新增发现**：最新 10 次 Actions 顶层均为 success；但业务日志仍暴露 `manual_intervention`、日期归档歧义、deploy 目标页验证 skipped；历史窗口中 main 分支曾出现 4 次失败（飞书 sync -> deploy 链路）；当前 `npm audit --omit=dev` 仍有 4 个 vulnerable packages；Actions 日志仍有 Node.js 弃用警告。
- **建议修复顺序**：先排查并复盘 main 飞书 deploy 链路历史失败，避免同类失败复发；再处理业务失败被绿色 Action 掩盖、图片日期归档歧义、飞书图片识别/DB pending、Workflow shell 语法测试缺口，然后补 npm audit fix、Node.js 弃用清理、环境契约与飞书/Telegram 差异文档。

## 最新 10 次 Actions 概览

截至 2026-06-18 13:04（Asia/Shanghai），仓库最新 10 次 Actions 顶层均为 `success`。其中包含 main 的 `Refresh Telegram Webhook`、`Deploy GitHub Pages`、`Sync (Main)`，以及 dev 的 `Sync (Dev)` 和 `Deploy Cloudflare Pages (Dev)`。这说明历史失败之后链路已有成功样本，但不能抵消下文的业务状态、AI 超时配置和依赖安全风险。

## 最近 10 次 dev Action 概览

| Run ID | Workflow | Channel | 结论 | 关键观察 |
| --- | --- | --- | --- | --- |
| `27726498174` | Deploy Cloudflare Pages (Dev) #183 | deploy | success | 页面验证步骤 skipped，因为没有 target thought 输入。 |
| `27726458941` | Sync (Dev) #57 | feishu | success | 图片识别与 DB 写入成功，recognition 约 37.7s，persist 约 6.6s，随后触发并等待 dev deploy 成功。 |
| `27726387902` | Sync (Dev) #56 | feishu | success | 业务结果为 `taskStatus=skipped`、`failureReason=no reliable image or filename date`、`failureDisposition=manual_intervention`；Action 仍为 success，且仍发送了飞书结果通知。 |
| `27726327927` | Deploy Cloudflare Pages (Dev) #182 | deploy | success | 页面验证步骤 skipped，因为没有 target thought 输入。 |
| `27726302111` | Sync (Dev) #55 | feishu | success | 触发并等待 dev deploy 成功；日志未见顶层失败。 |
| `27678013114` | Deploy Cloudflare Pages (Dev) #181 | deploy | success | 页面验证步骤 skipped，因为没有 target thought 输入。 |
| `27677944537` | Sync (Dev) #54 | telegram | success | Telegram 同步后触发并等待 dev deploy 成功。 |
| `27677722244` | Sync (Dev) #53 | feishu | success | 出现识别缓存读取 timeout、AI schema parse failure、DB timeout，最终 `pending_replay` + `auto_retry`，Action 仍为 success。 |
| `27677216135` | Deploy Cloudflare Pages (Dev) #180 | deploy | success | 目标 thought module 页面验证 success。 |
| `27677193064` | Sync (Dev) #52 | feishu | success | 飞书 `thought_edit` 为 `thought_edit_database_only`，DB stored 后触发 dev deploy，目标 `/misc/` 验证成功。 |

## main 分支历史失败记录（最近 20 次全分支扫描中发现）

最新 10 次 Actions 均为 success，但在 2026-06-17 22:53-23:29（Asia/Shanghai）的历史窗口中，main 分支出现 4 次失败，均发生在飞书同步 -> 部署链路：

| Run ID | Workflow | 失败步骤 | 影响 |
| --- | --- | --- | --- |
| `27700045978` | Sync (Main) feishu | `Trigger and wait for site deploy` | 飞书同步成功但 deploy 触发/等待失败，sync 整体标红 |
| `27700072997` | Deploy GitHub Pages | `Build and deploy site` | 站点构建失败，页面未更新 |
| `27698033957` | Sync (Main) feishu | `Trigger and wait for site deploy` | 同上，飞书 sync 成功但 deploy 链路断裂 |
| `27698068999` | Deploy GitHub Pages | `Verify deployed thought module page` | 站点构建成功但随想模块页面验证失败 |

> **关键发现**：main 分支飞书同步链路比 Telegram 更容易触发 deploy 失败。两次 sync 失败均发生在飞书通道，失败点均在 deploy 触发/等待阶段；两次 deploy 失败分别为构建失败和页面验证失败。这说明 main 分支飞书 -> deploy 链路是当前最薄弱环节，需要优先排查 deploy 触发超时和页面验证条件。

## npm 依赖安全审计

当前 `npm audit --omit=dev` 报告 4 个 vulnerable packages（2 moderate, 2 high），均可通过 `npm audit fix` 修复：

| 包 | 严重级别 | 问题 | 影响范围 |
| --- | --- | --- | --- |
| `dompurify` | moderate | 多个 XSS/sanitization bypass advisories，影响 `<=3.4.8` | HTML sanitization 依赖链 |
| `js-yaml` (<=4.1.1) | moderate | Quadratic-complexity DoS in merge key handling | workflow 测试中的 YAML 解析 |
| `ws` (8.0.0-8.20.1) | high | Memory exhaustion DoS from tiny fragments | Cloudflare Workers 开发依赖链 |
| `form-data` | high | CRLF injection via unescaped multipart field names and filenames | AI provider HTTP 请求、飞书 API 调用 |

> **建议**：在实施路线图短期阶段加入 `npm audit fix`，并在 CI 中考虑增加 `npm audit --audit-level=high` 检查。

## Node.js 运行时弃用警告

最近多次 Actions 日志中出现以下弃用警告，虽不阻断当前运行，但在 GitHub runner 升级后可能变为失败：

```text
[DEP0040] DeprecationWarning: The `punycode` module is deprecated
[DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized
Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24:
  actions/checkout@v4, actions/setup-node@v4
```

- **Workflow Node 版本**：所有 workflow 使用 `node-version: 22`（`actions/setup-node@v4`），但 `actions/checkout@v4` 和 `actions/setup-node@v4` 自身内部仍 target Node.js 20。
- **`punycode` 模块**：来自依赖链（可能是 `node-fetch` 或 `whatwg-url`），需要定位来源并替换。
- **`url.parse()`**：代码或依赖中使用了已弃用的 `url.parse()`，应迁移到 `new URL()` API。
- **项目测试文件数**：当前 38 个测试文件（`.test.mjs`），workflow 文件 9 个。

## 问题列表

### 1. dev 最近 10 次均为绿色，但业务失败会被 summary 吸收

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/重构优化文档.md`
  - 代码：`.github/workflows/sync-dev.yml`
  - 日志：`Sync (Dev) #53` / `27677722244`
- **证据**：
  - 日志片段：
    ```text
    taskStatus: "partialFailure"
    retryState: "pending_replay"
    persistenceStatus: "pending_replay"
    failureCategory: "database"
    failureDisposition: "auto_retry"
    ```
  - 代码片段：
    ```yaml
    - name: Write Feishu sync summary
    - name: Notify Feishu sync result
    ```
- **影响**：GitHub Action 绿色只证明 workflow 执行完毕，不能证明业务写入完成。真实使用时，飞书用户可能收到“已排队重试/部分失败”类回执，但仓库状态仍显示 success，排障容易漏看。
- **建议（最小修正）**：文档明确把 `taskStatus/failureDisposition/persistenceStatus` 作为业务成功判断依据；后续实现可新增一个可配置 gate，让 P1 业务失败在 dev 阶段标黄或生成 issue。
- **修复收益**：避免把绿色 Action 误读成端到端成功，提升线上排障准确性。
- **关联原则**：以代码为真 / 按场景审计

### 2. 飞书图片链路出现 AI schema 失败和 DB timeout，说明飞书真实风险高于 Telegram

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/restructure/modules/图片处理.md`
  - 代码：`src/app/use-cases/feishu-sync.use-case.mjs`、`src/adapters/feishu/sync-batch-logic.adapter.mjs`
  - 日志：`Sync (Dev) #53` / `27677722244`
- **证据**：
  - 日志片段：
    ```text
    recognition cache read failed ... timeout expired; continuing without cache
    recognition parse failure ... expected object at $
    image recognition failed for 2881424624148985
    queued database replay ... timeout expired
    ```
  - 代码片段：
    ```js
    FEISHU_RECOGNITION_IMAGE_INPUT_MODE: inline
    fetchFeishuImageResource(... messageId: context.message?.sourceMessageId, imageKey)
    ```
- **影响**：飞书图片必须通过 tenant token 下载资源并转 inline，且飞书图片 ID 是 `image_key`，不是 Telegram file_id。AI schema 失败和 DB timeout 叠加时，会进入 pending replay，用户体验和审计都比 Telegram 更复杂。
- **建议（最小修正）**：图片处理文档单列“飞书图片特有风险”；AI 调度设计中把飞书 inline 下载、schema parse failure、DB timeout 分开统计。
- **修复收益**：后续实现不会把飞书当作“Telegram 换皮”，能优先补飞书图片链路的可观测性。
- **关联原则**：以代码为真 / 合同优先

### 3. 飞书 skipped/manual_intervention 不会触发 deploy，但 Action 仍成功

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/消息链路.md`
  - 日志：`Sync (Dev) #56` / `27726387902`
- **证据**：
  - 日志片段：
    ```text
    taskStatus: "skipped"
    status: "skipped"
    failureDisposition: "manual_intervention"
    Trigger and wait for async dev site deploy: skipped
    ```
- **影响**：这类用户输入或识别无法落库的情况，在 GitHub 层仍是成功。若文档只写“workflow success”，会误导后续判断。
- **建议（最小修正）**：消息链路文档把 `manual_intervention` 作为业务终态列入重试与失败恢复表，不把它归为系统成功。
- **修复收益**：明确哪些失败需要人工处理，哪些能自动重试。
- **关联原则**：按场景审计

### 4. Workflow shell 脚本语法缺少自动校验

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/restructure/modules/clodflare-action.md`
  - 代码：`test/github-workflows.test.mjs`
  - 附件：`/Users/soulgo/Downloads/bug 报告.md`
- **证据**：
  - 本地验证：
    ```text
    node --test --test-name-pattern "workflow" test/github-workflows.test.mjs
    28 pass
    ```
  - 附件结论：
    ```text
    现有测试没有对 YAML 解析后的 run: shell 脚本做 bash -n/等价语法校验
    ```
- **影响**：历史上 heredoc 缩进错误导致 sync workflow 变红，但测试无法提前拦截。当前 worktree 的 heredoc 结束符已对齐，但测试缺口仍存在。
- **建议（最小修正）**：新增测试：用 `js-yaml` 解析 `.github/workflows/sync.yml` / `sync-dev.yml`，提取关键 `steps[].run` 后执行 `bash -n`。
- **修复收益**：防止 YAML 内嵌 shell 语法问题再次进入 main/dev。
- **关联原则**：合同优先 / 测试与质量保证

### 5. 当前 GitHub Variables 中缺少部分 workflow 引用变量，需文档标注“可选/空值”

- **严重级别**：P2
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/分支与环境一致性.md`
  - 配置：GitHub repository Variables
- **证据**：
  - 已存在变量：
    ```text
    AI_BASE_URL=https://www.packyapi.com/v1
    AI_MODEL=gpt-5.4-mini
    TELEGRAM_RECOGNITION_CACHE_ENABLED=true
    TELEGRAM_RECOGNITION_FALLBACK_BASE_URL=https://api.moonshot.cn/v1
    TELEGRAM_RECOGNITION_FALLBACK_MODEL=kimi-k2.6
    TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS=30000
    ```
  - workflow 还引用：
    ```text
    AI_PROVIDER, AI_TIMEOUT_MS, AI_CONCURRENCY, TELEGRAM_RECOGNITION_MODEL, FEISHU_API_BASE_URL
    ```
- **影响**：文档若把所有引用变量都写成必填，会与真实仓库配置不一致；若完全不写，又会让排障者不知道哪些变量为空是允许的。
- **建议（最小修正）**：环境文档区分“已配置必填”“已配置可选”“代码引用但当前未配置，允许空值/默认值”。
- **修复收益**：配置清单更贴近真实仓库，减少误报。
- **关联原则**：配置与环境变量

### 6. dev 飞书 app secret 允许 fallback 到生产 secret，隔离边界需要显式标注

- **严重级别**：P2
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/分支与环境一致性.md`
  - 代码：`.github/workflows/sync-dev.yml`
- **证据**：
  - 代码片段：
    ```yaml
    FEISHU_APP_ID: ${{ secrets.DEV_FEISHU_APP_ID || secrets.FEISHU_APP_ID }}
    FEISHU_APP_SECRET: ${{ secrets.DEV_FEISHU_APP_SECRET || secrets.FEISHU_APP_SECRET }}
    FEISHU_ALLOWED_CHAT_IDS: ${{ vars.DEV_FEISHU_ALLOWED_CHAT_IDS || vars.FEISHU_ALLOWED_CHAT_IDS }}
    ```
  - 当前 secrets 中存在 `DEV_FEISHU_APP_ID` / `DEV_FEISHU_APP_SECRET`，变量中存在 `DEV_FEISHU_ALLOWED_CHAT_IDS`。
- **影响**：当前配置是安全的，但代码允许 fallback。若将来 dev secret 被删，dev 可能使用生产飞书 app。
- **建议（最小修正）**：文档把 fallback 标为“允许但需报警”的风险；后续 preflight 可在 dev 环境检测到 fallback 时输出 warning。
- **修复收益**：降低 dev/main 环境漂移风险。
- **关联原则**：安全默认收紧 / 配置与环境变量

### 7. 飞书与 Telegram 的命令、ID、图片、回执差异需要独立建模

- **严重级别**：P2
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/restructure/modules/随想.md`
  - 代码：`src/adapters/feishu/sync-batch-logic.adapter.mjs`、`src/adapters/telegram/sync-batch-logic.adapter.mjs`
- **证据**：
  - 飞书代码：
    ```js
    messageId = buildStableSafeInteger(`feishu:message:${sourceMessageId || eventId}`)
    imageKey = normalizeText(content.image_key)
    ```
  - Telegram 代码：
    ```js
    messageId: message.message_id
    normalizeTelegramMarkdownDocument(message.document)
    ```
- **影响**：飞书 message_id 是字符串，需要映射为安全整数兼容旧 Telegram bigint 字段；飞书图片是 image_key，需要 tenant token 下载；Telegram 支持 Markdown document 附件正文，飞书当前不支持。
- **建议（最小修正）**：模块文档补差异矩阵，并把 `sourceMessageId/sourceChatId` 作为后续跨渠道 ID 设计的核心。
- **修复收益**：后续重构不会把飞书特性丢失在 Telegram facade 里。
- **关联原则**：术语与命名 / 合同优先

### 8. 部署验证步骤在无 target thought 输入时会 skipped，属于正常但要说明覆盖范围

- **严重级别**：P3
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/消息链路.md`
  - 代码：`.github/workflows/deploy-cloudflare-pages-dev.yml`
  - 日志：`Deploy Cloudflare Pages (Dev) #181/#182/#183`
- **证据**：
  - 代码片段：
    ```yaml
    if: success() && github.event_name == 'workflow_dispatch' && inputs.target_thought_id != '' && inputs.target_thought_path != ''
    ```
  - 日志现象：
    ```text
    Verify deployed thought module page: skipped
    ```
- **影响**：这不是失败，但说明最近三次 deploy 没有执行 thought module 目标校验。文档若用“Deploy success”证明随想模块校验，会证据不足。
- **建议（最小修正）**：文档明确该校验只覆盖 DB-only thought 变更携带 target 输入的场景。
- **修复收益**：避免过度解读 deploy green。
- **关联原则**：证据前置

### 9. GitHub Actions 日志存在 Node 运行时弃用警告

- **严重级别**：P2
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/优化实施路线图.md`
  - 日志：多次 dev sync run
- **证据**：
  - 日志片段：
    ```text
    [DEP0040] DeprecationWarning: The `punycode` module is deprecated
    [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized
    Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4
    ```
- **影响**：当前不阻断，但会污染日志并可能在未来 runner/runtime 升级时变为失败。
- **建议（最小修正）**：路线图加入依赖升级与 warning 清理任务，优先定位 `url.parse()` 来源。
- **修复收益**：降低未来 CI 突然失败风险。
- **关联原则**：测试与质量保证

### 10. GitHub environment 只配置 `github-pages`，无环境级 vars/secrets

- **严重级别**：待证据补充
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/分支与环境一致性.md`
  - 配置：GitHub Environments
- **证据**：
  - `gh api repos/soulgo/training_records/environments`：
    ```text
    github-pages, deployment_branch_policy.custom_branch_policies=true
    ```
  - `gh variable list --env github-pages` / `gh secret list --env github-pages`：
    ```text
    []
    ```
- **影响**：当前环境隔离主要靠 repo-level secrets/vars 和 workflow 条件，而不是 GitHub Environment 级配置。是否需要环境级隔离还要看后续权限模型。
- **建议（最小修正）**：文档记录现状，不把 environment-level secret 当作已配置能力。
- **修复收益**：避免误导运维人员去环境级找不存在的变量。
- **关联原则**：配置与环境变量

### 11. main 分支飞书 sync -> deploy 链路在历史窗口反复失败

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/消息链路.md`、`docs/优化重构/核心代码优化01/restructure/modules/clodflare-action.md`
  - 代码：`.github/workflows/sync.yml`（deploy 触发/等待逻辑）、`.github/workflows/deploy-pages.yml`
  - 日志：`27700045978`、`27700072997`、`27698033957`、`27698068999`
- **证据**：
  - 两次 sync 失败均在飞书通道，失败步骤为 `Trigger and wait for site deploy`。
  - 两次 deploy 失败分别为 `Build and deploy site`（构建失败）和 `Verify deployed thought module page`（页面验证失败）。
  - Telegram 通道在同期未出现类似失败。
- **影响**：这些历史失败发生时，main 分支飞书同步后站点未能成功部署，用户发送的飞书数据虽已入库但页面未更新。最新 10 次 Actions 已恢复全绿，但 `sync.yml` 中的 deploy 触发/等待逻辑仍需要复盘，避免同类故障再次出现。
- **建议（最小修正）**：排查 `sync.yml` 中 deploy 触发 API 调用的错误处理和超时行为；检查 `deploy-pages.yml` 构建失败和页面验证失败的具体原因；在 sync summary 中增加 deploy 触发的详细错误信息。
- **修复收益**：消除 main 分支飞书链路的可靠性短板。
- **关联原则**：审计优先 / 运行证据优先

### 12. npm 依赖存在 4 个 vulnerable packages（2 moderate, 2 high）

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/优化实施路线图.md`、`docs/优化重构/核心代码优化01/实施checklist.md`
  - 配置：`package.json`、`package-lock.json`
- **证据**：
  - `npm audit --omit=dev` 输出：
    ```text
    4 vulnerabilities (2 moderate, 2 high)
    dompurify: multiple XSS/sanitization bypass advisories
    form-data: CRLF injection via unescaped multipart field names and filenames
    js-yaml (<=4.1.1): Quadratic-complexity DoS in merge key handling
    ws (8.0.0-8.20.1): Memory exhaustion DoS from tiny fragments
    ```
  - 所有漏洞均标记 `fix available via npm audit fix`。
- **影响**：`dompurify` 影响 HTML sanitization 依赖链；`form-data` 影响所有 multipart 请求（AI provider、飞书 API）；`js-yaml` 影响 workflow 测试中的 YAML 解析；`ws` 影响 Cloudflare Workers 开发依赖链。虽然当前生产环境可能未被利用，但漏洞级别包含 high，应及时修复。
- **建议（最小修正）**：短期阶段执行 `npm audit fix`，并在 CI 中增加 `npm audit --audit-level=high` 检查。
- **修复收益**：消除已知安全漏洞，降低供应链攻击风险。
- **关联原则**：测试与质量保证

### 13. AI_TIMEOUT_MS 未配置且 AI_CONCURRENCY 缺少显式限流策略

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/AI 容灾与调度优化.md`
  - 配置：GitHub repository Variables
- **证据**：
  - GitHub Variables 中未配置 `AI_TIMEOUT_MS` 和 `AI_CONCURRENCY`。
  - `Sync (Dev) #57` 飞书图片识别耗时约 37.7s，说明真实运行仍接近 45s 建议 timeout，需要继续保留超时与 fallback 验收。
  - 原始审计时，代码中 `AI_TIMEOUT_MS` 为空会导致请求缺少 abort timeout；当前本地实现已把缺失、非法或小于等于 0 的 `AI_TIMEOUT_MS` 默认到 45000ms，并通过 AbortController 注入 fetch signal。
  - `AI_CONCURRENCY` 为空时 `runTelegramSync()` 默认 3，不是单并发；当前本地实现已支持 `AI_CONCURRENCY_MAX` clamp，防止误设过高。
- **影响**：AI 调用已有代码级默认超时保护；飞书图片批次仍需要显式限流策略和真实 dev/main 运行证据。飞书图片识别已观察到 37.7s 的耗时，接近 45s 建议 timeout。
- **建议（最小修正）**：配置 `AI_TIMEOUT_MS=45000`；如需降低飞书图片资源峰值，可配置 `AI_CONCURRENCY=2`，但文档必须标注这是限流策略，不是默认值修复。
- **修复收益**：防止 AI 调用无限等待或并发过载。
- **关联原则**：配置与环境变量

### 14. 图片日期归档在绿色 Action 下仍存在业务歧义

- **严重级别**：P1
- **位置**：
  - 文档：`docs/优化重构/核心代码优化01/restructure/modules/图片处理.md`、`docs/优化重构/核心代码优化01/消息链路.md`
  - 代码：`src/adapters/telegram/sync-dates.adapter.mjs`、`src/adapters/telegram/sync-batch-logic.adapter.mjs`
  - 日志：`27726387902`、`27726311686`、`27723440758`
- **证据**：
  - `Sync (Dev) #56` / `27726387902`：
    ```text
    taskStatus: "skipped"
    failureCategory: "user_input"
    failureReason: "no reliable image or filename date"
    failureDisposition: "manual_intervention"
    warnings: ["截图未显示测量日期或时间", "部分体成分数值单位为斤，已按 1 斤 = 0.5 kg 换算为 kg"]
    ```
  - `Sync (Main)` / `27726311686`：
    ```text
    message date: 2026-06-18 07:28:01 Asia/Shanghai
    warnings: ["截图仅显示 6月18日，缺少年份，无法可靠生成 YYYY-MM-DD 日期"]
    dateSources[0].detectedDate: "2026-06-17"
    dateSources[0].source: "sleep_bedtime"
    archivedDate: "2026-06-17"
    ```
  - `Sync (Main)` / `27723440758` 同批图片里同时出现 `6月18日` warning、`image header: 2026-06-17`、`sleep_bedtime` 和 `no_date`，但最终 Action 仍为 success。
- **影响**：用户从 Actions 看到 success，会误以为图片已按正确业务日期入库；实际可能是缺少可靠日期而跳过，或由睡眠跨日规则/消息年份补全规则推导到前一天。下一次重构若只看 `archivedDate`，会漏掉 dateSources 和 warnings 中暴露的业务歧义。
- **建议（最小修正）**：补日期归档合同测试和 summary gate：当 `warnings/dateSources` 中出现“缺少年份 / no reliable image date / source=no_date / source=sleep_bedtime”时，summary 必须标注 `dateConfidence=derived|uncertain|missing`；`manual_intervention` 和不确定归档不能算完整业务通过。
- **修复收益**：下次重构能一次性处理图片日期、睡眠跨日、Asia/Shanghai 消息日、文件名日期 fallback 与业务通过判定，避免再次出现绿色 Action 掩盖错误归档。
- **关联原则**：以代码为真 / 按场景审计 / 运行证据优先

## GitHub 配置快照

### Repository Variables

| 变量 | 当前值 | 说明 |
| --- | --- | --- |
| `AI_BASE_URL` | `https://www.packyapi.com/v1` | 主 AI base URL |
| `AI_MODEL` | `gpt-5.4-mini` | 主 AI model |
| `CLOUDFLARE_PAGES_BASE_URL` | `https://soulgo.chat` | main 页面校验 base URL |
| `CLOUDFLARE_PAGES_DEV_BASE_URL` | `https://training-records-dev.pages.dev` | dev 页面校验 base URL |
| `DEV_FEISHU_ALLOWED_CHAT_IDS` | `oc_47126c2d831c7a201c30c801ad77ef71` | dev 飞书允许 chat |
| `DEV_TELEGRAM_WEBHOOK_URL` | `https://feishu-dev.soulgo.chat/telegram` | dev Telegram webhook URL |
| `DEV_TRAINING_DB_APP_NAME` | `training-records-dev` | dev DB app name |
| `FEISHU_ALLOWED_CHAT_IDS` | `oc_fcee3808dc99f66aeb710ace2c0a084f` | main 飞书允许 chat |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `6314355239` | Telegram 允许 chat |
| `TELEGRAM_RECOGNITION_CACHE_ENABLED` | `true` | 识别缓存开关 |
| `TELEGRAM_RECOGNITION_FALLBACK_BASE_URL` | `https://api.moonshot.cn/v1` | 识别 fallback base URL |
| `TELEGRAM_RECOGNITION_FALLBACK_MODEL` | `kimi-k2.6` | 识别 fallback model |
| `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS` | `30000` | 识别 fallback timeout |
| `TELEGRAM_WEBHOOK_URL` | `https://feishu.soulgo.chat/telegram` | main Telegram webhook URL |
| `TRAINING_DB_ENABLED` | `true` | DB 开关 |
| `TRAINING_DB_TIMEOUT_MS` | `3000` | DB timeout |
| `TRAINING_SNAPSHOT_SOURCE` | `database` | 快照事实源 |

### Repository Secrets

Secrets 值不可反读，只能确认名称存在：

```text
AI_API_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_PAGES_API_TOKEN
CLOUDFLARE_ZONE_ID
DEV_FEISHU_APP_ID
DEV_FEISHU_APP_SECRET
DEV_GITHUB_TOKEN
DEV_TELEGRAM_BOT_TOKEN
DEV_TELEGRAM_SECRET_TOKEN
DEV_TRAINING_DB_URL
FEISHU_APP_ID
FEISHU_APP_SECRET
TELEGRAM_BOT_TOKEN
TELEGRAM_RECOGNITION_FALLBACK_API_KEY
TELEGRAM_SECRET_TOKEN
TRAINING_DB_URL
```

### GitHub Environment

- 仅有 `github-pages` environment。
- 当前 environment-level variables/secrets 为空。
- `github-pages` 有 custom branch policy，但文档不应假设它保存 DB/AI/通道配置。

## 飞书与 Telegram 差异矩阵

| 维度 | Telegram | 飞书 | 文档/设计影响 |
| --- | --- | --- | --- |
| Webhook 鉴权 | `X-Telegram-Bot-Api-Secret-Token` | verification token + HMAC 签名 + 可选 AES-CBC 加密信封 | Worker 文档必须分开写 |
| 入口返回码 | 多数成功为 202；help 可直接 200 | 成功/缓冲多为 200；url verification 返回 challenge | 不能统一写成一种状态码 |
| help | Worker 直接回复 help，不进 Actions | 当前主要走同步管线/Feishu notify | help 行为不对称 |
| 消息 ID | 原生整数 `message_id` | 字符串 `message_id`，适配层生成 safe integer 代理 | 需要 `sourceMessageId` 保留真实 ID |
| 图片 ID | `file_id` / `file_unique_id`，可 photo 或 image document | `image_key`，需 tenant token 下载 | 图片缓存 key 必须包含 channel |
| 图片分组 | Telegram album/media_group + DO 3 秒窗口 | 飞书按 chat + create_time 3 秒 burst 分组 | 分组规则不同 |
| Markdown 附件 | Telegram document 支持 `.md/.markdown` 正文 | 飞书当前不支持 Markdown 文档附件正文 | 随想能力有差异 |
| 发送回执 | Telegram Bot API `sendMessage` | 飞书 tenant token + `/im/v1/messages` | token 缓存和失败分类不同 |
| dev fallback | dev Telegram 严格用 dev bot token | dev Feishu workflow 允许 fallback 到 main Feishu secrets | 环境隔离风险不同 |

## 已核对但无需修改

- DB-only thought edit/move 是当前设计，不应把同步阶段直接改 Markdown 作为首选修复。
- 当前 worktree 中 `sync.yml` / `sync-dev.yml` 的 heredoc 结束符已对齐；附件中的 heredoc 缩进问题应记录为历史问题和测试缺口，而不是当前未修 bug。
- `SyncDispatchQueue` 已经存在并绑定在 main/dev Worker 中，文档应写“增强队列”而不是“从零新增顺序队列”。
