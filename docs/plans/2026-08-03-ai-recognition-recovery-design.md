# AI 图片识别恢复设计

## 目标

修复 OpenAI-compatible Responses 请求出现 HTTP 200 但无可提取文本时的诊断和恢复链路，确保 Telegram、飞书在 dev/main 环境均能正确排队、重放和反映业务结果。

## 方案

1. Responses 适配器继续优先解析官方 `output_text`，同时兼容网关返回的 Chat Completions `choices[0].message.content`。无文本时保留安全元数据：响应 `status`、`incomplete_details.reason`、output/content 类型和是否存在 refusal；不记录响应正文、图片内容、OCR 或健康数据。
2. 图片识别将无文本、incomplete 和 refusal 作为带上下文的 provider 错误，交给现有技术 fallback。fallback 只要求单独配置模型；未单独配置 key/base URL 时继承主 provider，显式配置仍优先。
3. 飞书生产入口显式启用默认 pending store。pending 重放以来源渠道为边界；历史来源不一致任务不得交给错误渠道 API。现有 dev 重放扩展为 dev/main 两套任务，分别读取对应数据库和凭据。
4. 同步程序始终先写结果文件并发送详细 Telegram/飞书回执。回执完成后，若本次存在未恢复的图片识别业务失败，则由独立 workflow gate 令 Action 失败，避免绿色 conclusion 被误解为识别成功。

## 验证

- 单元测试覆盖官方 Responses、兼容网关响应、incomplete/refusal 安全错误和 fallback 继承。
- 同步测试覆盖飞书 pending store、跨渠道任务防护及业务失败判断。
- workflow 测试覆盖 dev/main pending replay 和通知后的业务失败 gate。
- 运行相关测试、全量 `npm test`、识别评估与数据一致性静态检查。
