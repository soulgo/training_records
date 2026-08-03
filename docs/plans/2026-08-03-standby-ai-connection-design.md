# 备用 AI 独立连接与降级设计

## 现状与根因

dev 的 Telegram 和飞书同步都已正确把图片业务失败反映为 Action failure。失败日志显示主模型为 `gpt-5.4-mini`，备用模型为 `kimi-k2.6`，但仓库没有配置备用 key/base URL，因此备用模型继承主 GPT 的 `AI_API_KEY` / `AI_BASE_URL`，被发送到不提供 Kimi 的 `codex` 分组并返回 HTTP 503。飞书失败图片属于主 GPT 空 Responses 后的技术 fallback；Telegram 属于主结果不完整后的业务补全，当前业务补全异常会错误丢弃主结果。

## 配置契约

新增通用 GitHub Secrets `STANDBY_AI_API_KEY` 和 `STANDBY_AI_BASE_URL`，供 Telegram、飞书和 pending replay 共用。运行时连接解析顺序为：`STANDBY_AI_*`、旧 `TELEGRAM_RECOGNITION_FALLBACK_*`、主 `AI_*`。备用模型与超时继续使用现有 `TELEGRAM_RECOGNITION_FALLBACK_MODEL` / `TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS`，避免要求一次迁移全部配置；旧备用连接名继续兼容。

## 失败语义

主 AI 技术失败后调用备用 AI，两者都失败时仍判图片技术失败并进入 pending。主 AI 已返回 schema 合法结果、仅因完整性需要业务补全时，备用 AI 失败不再覆盖主结果：保留主数据与原完整性状态，记录 `fallback_failed` 和不含上游正文的安全警告，再由现有“是否有可写入数据”门禁决定入库。这样备用增强不可用不会删除主 AI 已识别的数据，同时无可写入数据仍保持诚实失败。

## 验证

- provider 装配测试覆盖新 Secrets 优先级与旧配置兼容。
- 识别用例测试覆盖业务补全 503 后保留主结果。
- workflow 测试覆盖 main、dev、pending replay 的新 Secret 注入。
- 运行相关测试、全量测试、识别契约评估，并在 dev 推送后检查远端 Actions 与真实消息重试。
