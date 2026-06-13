# 自适应图片解析入库 v15

将 Telegram 健康截图识别从"华为健康专属"升级为"任意健康 APP 自适应提取"。

本轮采用单阶段方案：**AI 记忆式字段映射**。系统不改变现有 PostgreSQL 表结构，不改变页面展示，只让 AI 根据 App Profile 和通用 prompt，把截图上真实可见的时间、数值和标签映射到现有 schema 字段；看不出来的字段保持 `null` 或空数组。

## 阅读顺序

1. [自适应图片解析入库 v15 方案](./自适应图片解析入库_v15.md)（核心设计）
2. [实施 Checklist](./实施checklist.md)（编码时逐项勾选）

## 前置依赖

- **v13**（数据统一与六边形架构重构）：确立了 PostgreSQL 单一事实源和四层架构
- **v11**（Telegram 同步 PostgreSQL 提速）：建立了 AI 识别缓存机制和 OpenAI 兼容 API 适配

v15 是在 v13 架构基础上的能力升级：从"适配一个 APP"到"适配任意 APP 的现有字段"。

## 当前实施状态（2026-06-13）

- Schema 升级到 `v2`，顶层新增 `detectedApp`。
- 识别归一化会保留 `detectedApp`，旧返回缺少该字段时归一为 `null`。
- Batch 输出第一个非空 APP 来源，用于日志、审计和后续识别效果分析。
- Prompt 已通用化：`prompts/_source/recognition-rules.json` 增加自适应提取规则，运行时 prompt 已由生成器重新生成。
- AI 记忆载体已建立：`prompts/_source/app-profiles.json` 先覆盖 `华为健康` 和 `Apple Health` 的页面特征、字段别名、单位换算和时间优先级。
- 不改 core 表结构，不改页面展示，不保存现有 schema 之外的指标。

## 核心改动

- **App Profile 记忆**：维护 APP 名称、页面特征、字段别名、单位换算和时间优先级。
- **Prompt 通用化**：移除华为专属提示，要求 AI 只提取截图真实可见数据。
- **Schema 契约升级**：新增 `detectedApp` 并将 schema version 升到 `v2`，使识别缓存自动失效。
- **来源审计**：`recognition_json` 和 batch 结果保留 APP 来源，便于后续按 APP 调整 profile 和测试样例。
- **现有字段优先**：所有入库仍使用现有 core 固定列；新增 APP 时主要修改 App Profile 和 fixture。

## 改动范围

v15 主要涉及 prompt 规则、`prompts/_source/app-profiles.json`、JSON schema 兼容、识别归一化、batch 审计字段和测试样例。不涉及数据库 schema、core writer 或页面展示。
