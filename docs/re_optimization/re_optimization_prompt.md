# Telegram Prompt 重构实施计划

## Summary
把 Telegram 图片识别与 `/analysis` 的 prompt 从“手写成品文案”改成“结构化源 + 生成器输出”，同时保留现有运行时读取 `prompts/*.md` 的方式不变。`skills` 只作为维护辅助，不进入 bot 运行时链路。

## Key Changes
- 新增结构化 prompt 源，集中维护共享规则：
  - 识别输出 schema 约束
  - 日期与证据规则
  - 空值、`confidence`、`warnings` 口径
  - `/analysis` 的时间窗约束与长期目标
- 新增生成层，把结构化源编译成当前运行时使用的 `prompts/telegram-training-image-recognition.md` 和 `prompts/training-analysis.md`。
- 保持现有环境变量和调用入口不变：
  - `tools/telegram-sync.mjs` 继续读识别 prompt
  - `tools/training-analysis.mjs` 继续读分析 prompt
- 压缩 `/analysis` 请求体，把 `focus` 和 `summary` 改成更紧凑的 JSON 形态，减少 token 浪费。
- 更新文档，把“以后改规则只改结构化源，不直接手写成品 prompt”写成维护规范。

## Test Plan
- 为生成器加测试，确保生成后的 prompt 包含关键约束且无重复遗漏。
- 扩展现有测试，覆盖：
  - prompt 加载路径不变
  - 时间窗约束仍正确传递
  - `/analysis` 请求体压缩后语义不变
- 回归执行：
  - `test/training-analysis.test.mjs`
  - `test/telegram-sync.test.mjs`
  - `npm test`

## Assumptions
- 不改 Telegram 命令、数据库 schema、现有 JSON schema。
- `skills` 仅用于 Codex 维护流程，不作为 Telegram 运行时依赖。
- 现有 `prompts/*.md` 路径保持兼容，避免影响部署和回退逻辑。
