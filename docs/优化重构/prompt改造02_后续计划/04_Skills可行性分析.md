# 04 Skills 可行性分析：基于当前代码能力

## 结论

当前代码不支持 Skills 作为图片识别运行时编排单元。本轮不迁移 Skills，不把 Skills 写入实施主路径。

判断：

| 方向 | 结论 | 原因 |
|---|---|---|
| 立即迁移全部 Skills | 不可行 | 当前无 Skill runtime、无 skill version trace、无多调用 orchestration、无回滚开关 |
| 先分类再调用专项 Skill | 不可行 | 当前 `recognizeTelegramImageMessage()` 是单次请求，cache/pending/ingest 都按单结果设计 |
| Result validation 独立成代码模块 | 可行 | 可在现有 schema 后、batch 前增加普通 JS validator，不需要 Skills 架构 |
| Prompt source 模块化 | 可行 | 当前已有 JSON source 和 generator |
| 未来 Skills 试点 | 需改造 | 必须先完成合同测试、trace、pending replay、成本控制 |

## 当前代码能力

### 已有能力

- 单 Prompt 生成：`tools/prompt-generator.mjs`。
- 单图片 AI 调用：`recognizeTelegramImageMessage()`。
- schema 校验：`buildRecognitionSchema()`。
- response format fallback：strict schema -> json_object -> 无 response format。
- provider fallback：识别 provider 可配置 fallback provider。
- 识别缓存：`buildRecognitionCacheKey()` 包含 fileUniqueId、promptVersion、schemaVersion、model。
- pending replay：`ingest.telegram_pending_batch` 保存 batch payload。
- 飞书复用：飞书事件转成 Telegram-compatible batch，共享识别链路。

### 缺失能力

- NOT IMPLEMENTED IN CODE：Skill 注册表。
- NOT IMPLEMENTED IN CODE：Skill 选择器或 classifier。
- NOT IMPLEMENTED IN CODE：每类图片的独立 Prompt 运行时加载。
- NOT IMPLEMENTED IN CODE：多次 AI 调用结果合并协议。
- NOT IMPLEMENTED IN CODE：classifierVersion、skillVersion、validatorVersion trace。
- NOT IMPLEMENTED IN CODE：按 Skill 回滚开关。
- NOT IMPLEMENTED IN CODE：按 Skill 统计成本、超时、失败率。
- NOT IMPLEMENTED IN CODE：pending replay 恢复多 Skill 调用上下文。

## 为什么本轮不能以 Skills 为核心

### 1. 当前 P0 是合同问题，不是编排问题

已确认问题：

- Prompt 要求 `records.sleep`，schema 没有 required。
- Prompt 允许 meals recommended null，schema 不允许。
- fallback Prompt 漏掉 sleep。

这些问题即使迁移 Skills 也仍然存在，甚至会被复制到多个 Skill。

### 2. 当前 cache 和 pending 都按单识别结果设计

当前 cache key：

```text
telegram:file_unique_id:<id>:prompt:<version>:schema:<version>:model:<model>
```

当前 pending payload 保存 batch，不保存：

- classifier Prompt/version。
- type Skill Prompt/version。
- validator version。
- 多次 AI 调用中间结果。

因此 Skills 化前必须先扩展 trace 合同。

### 3. 飞书复用依赖共享链路

`runFeishuSync()` 当前通过 `runTelegramSync()` 复用图片识别。Skills 如果在入口层分叉，容易重新制造 Telegram/飞书差异。

本轮必须保留：

- 通道只处理传输差异。
- 图片识别语义共享。
- `sourceChannel` 只作为来源 metadata。

## 可行的替代动作

### A. Prompt source 模块化

可行。

实施面：

- `prompts/_source/recognition/*.json`
- `tools/prompt-generator.mjs`
- `test/prompt-generator.test.mjs`

不改变运行时调用。

### B. Result validation 普通代码模块

可行，但不命名为 Skill。

建议位置：

```text
src/app/use-cases/image-recognition.use-case.mjs
  parseRecognitionContent()
    -> normalizeRecognitionPayload()
    -> validateAiJsonValue()
    -> validateRecognitionBusinessRules()  // 新增普通函数/模块
```

第一批规则只做 report 或 warnings，不直接阻断：

- sleep 阶段分钟合计与 total/night 差异过大。
- measurement 数值明显异常。
- workout detail 不能被现有正则解析时加 warning。
- nutrition recommendedMin > recommendedMax。

验收：

```bash
node --test test/ai-recognition-service.test.mjs test/telegram-sync.test.mjs
```

### C. Skills 试点前置条件

只有满足以下条件后，才可以重新评估 Skills：

1. P0 合同问题已修复。
2. fallback Prompt 与 schema v2 一致。
3. 有四类图片的最小 fixtures。
4. ingest recognition 能记录足够 trace。
5. pending replay 能复现版本上下文。
6. Telegram/飞书同图输入行为一致。
7. 已证明单 Prompt 在某类图片上存在可量化瓶颈。

## 如果未来要做 Skills，需要先改哪些代码

这是未来改造清单，不属于本轮实施。下表所有能力当前均为 `NOT IMPLEMENTED IN CODE`：

| 能力 | 需改代码 | 说明 |
|---|---|---|
| NOT IMPLEMENTED IN CODE：Skill 注册 | 新增 runtime 模块 | 定义 skill id、version、prompt、schema |
| NOT IMPLEMENTED IN CODE：分类调用 | `recognizeBatch()` 或新 use case | 先判断 imageType，再调用专项识别 |
| NOT IMPLEMENTED IN CODE：trace | `recognition_json`、batch payload | 保存 classifier/type skill/model/schema/profile version |
| NOT IMPLEMENTED IN CODE：pending replay | `telegram_pending_batch` payload | 保存足够恢复多调用的信息 |
| NOT IMPLEMENTED IN CODE：cache key | `buildRecognitionCacheKey()` | 需要加入 skill id/version |
| NOT IMPLEMENTED IN CODE：回滚开关 | env/config | 可按类型回综合 Prompt |
| NOT IMPLEMENTED IN CODE：评估 | 新 tooling/test fixtures | 对比综合 Prompt 与 Skill 输出 |

## 本轮文档口径

所有后续文档必须使用以下口径：

- “Skills 当前不可作为实施路径。”
- “本轮以 Prompt source、schema、fallback、测试、DB 映射为主。”
- “Result validation 可以先做普通代码模块，不写成已实现 Skill。”
- “Skills 只保留为未来需改造选项，且必须标注 NOT IMPLEMENTED IN CODE。”

## Go / No-Go

| 选项 | 判断 | 本轮动作 |
|---|---|---|
| 立即 Skills 化 | No-Go | 删除出主路线 |
| 设计 Skills 架构 | No-Go | 不输出架构方案 |
| Prompt source 模块化 | Go | 进入 03/07/08 |
| schema/fallback 合同修复 | Go | 进入 07/08 |
| 普通 result validator | Go after P0 | 作为后续可执行代码模块 |
