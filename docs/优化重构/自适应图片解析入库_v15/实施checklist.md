# 实施 Checklist — 自适应图片解析入库 v15

逐项勾选，按顺序执行。v15 只做 AI 记忆式字段映射，不改现有表结构、不改页面展示。

## 第零阶段：需求边界确认

- [x] **0.1** 明确本轮目标：提升 AI 对不同健康 APP 截图的现有字段提取能力
  - AI 只提取截图上真实可见的时间和数据
  - 现有 schema 中看不出来的字段输出 `null` 或空数组
  - 不因为新 APP 截图新增页面字段或 core 固定列
  - 影响：约束 v15 范围，避免把跨 APP 适配做成数据库扩表

- [x] **0.2** 定义 AI 记忆载体
  - 新增 `prompts/_source/app-profiles.json`
  - 记录 APP 名称、页面特征、字段别名、单位换算、时间优先级
  - 记忆必须落在仓库文件和 `test/fixtures/telegram-recognition/` 样例中，不依赖模型不可控的会话记忆
  - 影响：后续适配新 APP 时主要改配置和样例，不改写库主链路

- [x] **0.3** 准备至少一组非华为 APP 识别样例
  - 完成：新增 `test/fixtures/telegram-recognition/apple-health-sleep-visible-core-fields.json`
  - 覆盖 Apple Health 可见时间、核心睡眠字段和不可见字段留空

## 第一阶段：Schema + Prompt

- [x] **1.1** `src/core/ai/telegram-recognition-schema.mjs`
  - 顶层 `properties` 增加 `detectedApp: { type: ['string', 'null'] }`
  - 顶层 `required` 增加 `'detectedApp'`
  - `RECOGNITION_SCHEMA_VERSION` 改为 `'v2'`
  - 影响：缓存自动失效，AI 输出契约变更；仍只写现有字段

- [x] **1.2** `prompts/_source/recognition-rules.json`
  - 删除 workout.rules 中华为专属文字，改为通用描述
  - 新增 `adaptiveExtraction` 章节
  - 增加 AI 记忆式字段映射说明：字段别名、单位换算、时间优先级、不可见字段留空
  - measurement / workout / nutrition / sleep rules 末尾增加"只提取截图真实可见数据，无法可靠识别填 null"的守护规则
  - metadata.version 更新日期
  - 影响：AI 行为变更，但不改变 core 表结构和页面展示

- [x] **1.3** `prompts/_source/app-profiles.json`
  - 建立最小 profile 结构：`appAliases`、`pageTypes`、`fieldAliases`、`unitConversions`、`timePriority`
  - 先放 `华为健康` 当前口径和 `Apple Health` 样例口径
  - 影响：以后新增 APP 主要改 profile 和测试 fixture

- [x] **1.4** `tools/prompt-generator.mjs`
  - 让生成器把 profile 摘要编译进 `prompts/telegram-training-image-recognition.md`
  - profile 内容保持短而可控，避免把 prompt 变成无限增长的 APP 百科

- [x] **1.5** 运行 `node tools/prompt-generator.mjs` 重新生成 prompt
  - 检查 `prompts/telegram-training-image-recognition.md` 输出包含新章节

## 第二阶段：归一化层 / Batch 层

- [x] **2.1** `src/app/use-cases/image-recognition.use-case.mjs`
  - 确认 `normalizeRecognitionPayload()` 不丢 `detectedApp`
  - 旧返回缺少 `detectedApp` 时归一化为 `null`
  - 现有字段归一化保持原行为；看不出的字段继续是 `null` 或空数组

- [x] **2.2** `src/adapters/telegram/sync-batch-logic.adapter.mjs`
  - batch 输出增加 `detectedApp` 字段
  - 取第一个通过置信度门槛的非空 `recognition.detectedApp`
  - measurement / workout / nutrition / sleep 仍只消费现有 schema 字段
  - 影响：增加审计信息，不影响 core 固定列和页面展示

## 第三阶段：验证

- [x] **3.1** 现有测试回归：`npm test` 全部通过
- [x] **3.2** 华为截图回归：本地回归测试确认现有华为睡眠字段归一化和核心字段提取不变
- [x] **3.3** 非华为 APP 测试：Apple Health fixture 确认：
  - `detectedApp` 正确保留
  - 核心字段正常提取
  - 截图不可见字段保持 `null` 或空数组，不臆造
  - 不需要新增 core 表字段，不改变页面展示
- [x] **3.4** 入库审计验证：本地测试确认 `ingest.telegram_recognition.recognition_json` 保留 `detectedApp`
- [x] **3.5** 文档验证：README、方案页、长期维护文档和 CHANGELOG 已同步当前单阶段方案
