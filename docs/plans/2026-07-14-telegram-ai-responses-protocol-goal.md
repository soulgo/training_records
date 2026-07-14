# Goal Document: 修复 Telegram 图片识别协议不兼容

## Go / No-Go
- **Judgment**: Go
- **Reason**: 线上错误、远端 Action 日志和本地 provider 实现形成了完整证据链；可用单元测试约束协议转换，并通过 dev 工作流验证真实链路。

## Target Outcome
Telegram 图片批次使用 `gpt-5.4-mini` 时走 Responses API，4 张图片不再因 `/chat/completions` 协议不兼容全部进入重试队列；GitHub Actions 的实际触发和任务状态可被准确解释与验证。

## Goal Definition
- **Type**: technical / operational / quality
- **Boundary**: 包含 AI provider 的 Chat Completions 与 Responses 双协议支持、workflow 配置透传、provider/识别相关测试、必要文档、dev 线上变量与运行验证；不改变识别 schema、Prompt、数据库结构和 Telegram 分组规则。
- **Non-goals**:
  - 不更换 `gpt-5.4-mini`，不迁移到其他 AI 供应商。
  - 不重做同步队列、Action monitor 或识别业务状态机。
  - 不删除历史本地分支，不创建新分支。
- **Deferred work**:
  - 将“业务部分失败”映射为 GitHub job failure 或 neutral 的产品决策另行处理。
  - main 环境上线仅在 dev 实际验证通过后进行。
- **Verification rule**: 单元测试证明 endpoint、请求体、视觉输入、结构化输出、响应内容与 usage 均被正确转换；相关测试与完整快速测试通过；dev Action 运行可见并不再出现“模型不支持 chat completions 协议”。
- **Evidence source**: test / command / GitHub Actions trace / Telegram behavior
- **Pass criteria**: 本地 RED→GREEN 证据完整；dev workflow 成功部署配置；重试任务或新图片批次的日志不再包含协议不兼容 400。
- **Confidence note**: 请求与响应映射以 OpenAI 官方 Responses 迁移、视觉输入、Structured Outputs 文档为准；最终兼容性以当前第三方 OpenAI-compatible endpoint 的 dev 运行作为权威证据。
- **Judgment owner**: 自动测试负责代码正确性，GitHub Action trace 与 Telegram 实际结果负责线上完成判定。

## Current State
- `src/adapters/ai/openai-compatible.adapter.mjs` 无条件请求 `${baseUrl}/chat/completions`。
- GitHub 变量 `AI_MODEL=gpt-5.4-mini`；线上服务返回 HTTP 400，明确说明该模型不支持 Chat Completions。
- 2026-07-14 的 dev 同步 Action `29297289297` 实际已执行且 job 为 success；定时重试 Action `29297458473` 再次复现 4/4 失败。
- workflow 尚未注入协议选择变量；pending replay 也缺少识别专用模型、fallback 和 capability 配置。
- 当前分支为允许的 `dev`，已 fast-forward 到 `origin/dev`。

## Priority Rationale
- 先用 adapter 单元测试固定协议边界，避免在 workflow 中用模型名硬编码补丁。
- 再补 workflow 透传，确保即时同步和定时重试使用同一协议配置。
- 最后在 dev 真实运行，区分“代码正确”与“第三方 endpoint 兼容”。

## Assumptions and Open Decisions
| Item | Status | Impact | Owner / Next step |
|------|--------|--------|-------------------|
| 第三方 endpoint 支持 OpenAI Responses 请求形状 | assumed | 决定线上能否恢复 | dev Action 实测；若失败，按返回体收窄兼容层 |
| 配置名使用 `AI_API_PROTOCOL`，值为 `chat_completions` 或 `responses` | confirmed | 避免根据模型名猜协议 | adapter 校验并由 Actions variable 显式选择 |
| 保持 provider port 的 `requestChatCompletion` 方法名以缩小改动 | assumed | 内部命名暂时与实际协议不完全一致 | 本次保持调用方兼容，后续可独立重命名 |
| Action job 对可重试识别失败仍显示 success | confirmed | 解释“看不到失败 Action”的现象 | 本目标只记录并说明，不改变状态语义 |

## Phases

### Phase 1: 固定协议兼容契约
- **Purpose**: 用失败测试证明 Responses 行为当前缺失。
- **Entry condition**: 远端日志和本地实现已确认根因。
- **Phase rules**:
  - 只改测试，不改生产代码，直到 RED 因目标行为缺失而失败。
  - 覆盖 endpoint、输入内容、结构化输出、响应归一化和 usage。
- **Todos**:
  - [ ] 添加 Responses provider 行为测试。
    - **Surface**: `test/ai-provider.test.mjs`
    - **Proof**: 定向 `node --test` 因请求仍发往 `/chat/completions` 而失败。
    - **Depends on**: none
- **Exit proof**: RED 失败原因与线上 400 根因一致。
- **Stop condition**: 若第三方协议与官方 Responses 形状有已知冲突，先补证据再实现。

### Phase 2: 最小双协议实现
- **Purpose**: 保留默认 Chat Completions 兼容，同时允许显式选择 Responses。
- **Entry condition**: Phase 1 RED 成立。
- **Phase rules**:
  - 不按模型名自动猜协议。
  - 对现有调用方返回 Chat Completions 兼容 payload，避免扩散改动。
  - 非 2xx 响应保持原始错误体，供现有错误摘要读取。
- **Todos**:
  - [ ] 在 provider 中规范化并校验 `AI_API_PROTOCOL`。
    - **Surface**: AI adapter
    - **Proof**: 配置测试通过，无效值快速失败。
    - **Depends on**: Phase 1
  - [ ] 实现 Responses 请求和响应适配。
    - **Surface**: AI adapter
    - **Proof**: RED 测试转 GREEN，原 Chat Completions 测试仍通过。
    - **Depends on**: 协议配置
- **Exit proof**: provider 定向测试全部通过。
- **Stop condition**: 若必须修改识别 schema 或 Prompt 才能调用，则暂停并重评边界。

### Phase 3: 接通所有运行入口
- **Purpose**: 确保即时同步与 pending replay 都使用同一配置。
- **Entry condition**: Phase 2 GREEN。
- **Phase rules**:
  - main/dev workflow 同步维护。
  - 不在 YAML 中硬编码模型判断。
- **Todos**:
  - [ ] 向 sync、sync-dev、pending-replay 注入 `AI_API_PROTOCOL` 与现有 capability/识别配置。
    - **Surface**: GitHub workflows
    - **Proof**: workflow 文本测试或静态断言通过。
    - **Depends on**: Phase 2
  - [ ] 更新 env 示例和图片识别/AI 排查文档。
    - **Surface**: config docs
    - **Proof**: 文档与代码配置名一致。
    - **Depends on**: workflow 配置
- **Exit proof**: 所有 AI 运行入口均能收到协议变量。
- **Stop condition**: 如果 workflow 语法校验失败，不进入部署。

### Phase 4: 回归与 dev 线上验证
- **Purpose**: 证明修复没有破坏现有调用，并在真实 endpoint 验证。
- **Entry condition**: 本地实现与配置完成。
- **Phase rules**:
  - 先本地测试，后提交与推送。
  - commit message 必须中文；推送前当前分支必须是 `dev`，待推送提交说明全部为中文。
- **Todos**:
  - [ ] 运行定向测试、快速测试与 workflow 相关测试。
    - **Surface**: test suite
    - **Proof**: 命令退出码 0。
    - **Depends on**: Phase 3
  - [ ] 设置 dev GitHub variable `AI_API_PROTOCOL=responses`，提交并推送 `dev`。
    - **Surface**: GitHub config / Git
    - **Proof**: `gh variable get`、Git push、触发的 Actions。
    - **Depends on**: 本地测试通过
  - [ ] 手动运行 pending replay 或观察新图片任务。
    - **Surface**: GitHub Actions / Telegram
    - **Proof**: 不再出现 protocol 400；识别成功或暴露下一层独立错误。
    - **Depends on**: dev 部署完成
- **Exit proof**: dev trace 证明 Responses 请求通过协议层，目标错误消失。
- **Stop condition**: 第三方 endpoint 返回新的协议形状错误时停止扩大改动，仅基于其明确响应修正兼容层。

## Dry-Run Findings
- 单改 adapter 不够：workflow 必须透传显式协议，pending replay 也必须一致，否则重试仍走默认 Chat Completions。
- “GitHub 没任何 Action”与远端事实不符；实际是 workflow_dispatch 与 scheduled run 均成功，业务识别失败未使 job 失败。
- fallback 没有接管本次错误，是因为当前 fallback 判定不把 HTTP 400 视为瞬时故障；这符合现有设计，不应通过扩大 fallback 条件掩盖协议配置错误。
- 线上变量变更必须与代码部署顺序协调：代码先兼容默认值，再设置变量并推送，避免旧代码读取未知配置产生影响。

## Final Validation
- `node --test test/ai-provider.test.mjs`
- workflow/config 定向测试（若现有测试可扩展）
- `npm run test:fast`
- `git diff --check`
- `gh variable get AI_API_PROTOCOL`
- dev workflow / pending replay 日志中不含 `不支持 chat completions 协议`

## First Execution Step
在 `test/ai-provider.test.mjs` 添加 Responses API 的失败测试，并运行定向测试确认 RED。
