# AI Schema Validator

## 1. 作用

当前只对 Telegram 图片识别返回做轻量 JSON 校验和错误分类。

- `AiProviderError`：AI 返回为空
- `AiSchemaError`：返回不是合法 JSON，或缺少必需字段

## 2. 默认行为

- 不改变合法识别结果的 normalize 行为
- 不改变低置信度 skipped 逻辑
- 不引入大型 validator 依赖

## 3. 兼容策略

- 仅在图片识别解析阶段启用
- `RecognitionResult` 现有字段不变
- 旧 batch shape 不变

## 4. 回滚方式

- 删除识别链路中的 validator 调用即可回到原始 JSON.parse 行为

## 5. 风险等级

中

## 6. 验证

```bash
node --test test/ai-schema-validator.test.mjs test/telegram-sync-runner.test.mjs
```
