# Changelog

本项目所有显著变更都会记录在此文件中。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

维护约定：

- 最新正式版本是第一个形如 `## [x.y.z] - YYYY-MM-DD` 的发布条目；站点页脚版本号从这里自动读取。
- 保留 `## [Unreleased]` 记录尚未发布的显著变更，发布时移动到新的版本条目。
- 版本按时间倒序排列，发布日期使用 `YYYY-MM-DD`。
- 变更类型按需使用 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`；没有内容的分类不保留。

## [Unreleased]

### Fixed

- Telegram 同步的成功回执现在改为在 GitHub Action 最后阶段统一发送，不再在 `sync:telegram` 步骤完成时提前回发。
- 修复训练数据回写在合并既有训练日时误触发 `core.thought` 读取而报 `Unexpected SQL` 的问题，避免 2026-05-26 这类训练截图数据卡在回退链路里。

## [1.1.8] - 2026-05-27

### Added

- Telegram 随想新增、编辑、删除和移动成功后会回发同步反馈，让随想写入和训练图片解析入库保持一致的成功确认体验。
- 新增 GitHub Action 失败监控脚本：`repository_dispatch` 触发的 Telegram 同步失败时，会回 Telegram 显示失败阶段、失败分类和 GitHub run 排查入口。

### Changed

- `buildTelegramSyncReport()` 增加 `failureCategory`、`failureReason`、`recognitionErrors` 可观测字段，便于区分用户输入、AI 服务、Telegram API、数据库、GitHub Action 和系统代码异常。
- `pending_replay` 通知明确说明“Markdown 已写入，数据库待补偿”，不再伪装成数据库写入成功。
- 同步项目包版本号到 `1.1.8`。

### Fixed

- Worker 在缺少 GitHub Token、GitHub dispatch 失败或相册缓冲 dispatch 失败时，会尽量直接回 Telegram 说明“GitHub Action 未能启动”，避免误判为业务代码写入失败。
- 图片识别、`/分析` 和 `/ai` 失败通知保留 AI、网络、schema/JSON 等具体失败原因，不再只返回笼统的 `missing recognition`。
- Telegram 帮助命令现在同时支持 `/帮助` 和裸 `help`；即使帮助消息已经进入 `Telegram Sync`，也会直接回发命令清单，不写数据库、Markdown 或图片识别结果。

## [1.1.7] - 2026-05-26

### Added

- 新增 Telegram `/ai` / `/智能助手` Agent 入口：会按问题调用 MCP 工具查询历史记录、同步状态、配置、身体反馈或训练分析，并直接回发 Telegram。
- Cloudflare webhook 现在会直接响应 `/help`、`帮助`、`命令` 等帮助消息，返回当前可用命令清单，不再为帮助请求触发 GitHub Actions。
- Telegram 帮助清单覆盖截图识别、随想创建、编辑、删除、移动、`/分析` 和 `/ai` 等日常入口。

### Changed

- 同步项目包版本号到 `1.1.7`。

## [1.1.6] - 2026-05-26

### Added

- 新增 Telegram webhook 自动刷新脚本与 GitHub Actions 工作流：Worker 部署后会自动调用 `setWebhook`，并支持手动或每 6 小时定时刷新，减少更换 Bot Token 后漏设 webhook 的风险。
- `/分析` 现在会读取身体反馈记录，并在训练、饮食、恢复和疼痛/不适建议中结合反馈发生日期、时间点与近期训练负荷。
- 新增 MCP v1 stdio Server：通过 `npm run mcp:server` 暴露训练快照、每日记录、体脂、活动、饮食、身体反馈、图表、分析摘要、配置和运行状态等只读 Tool。
- 新增 `training.generate_analysis` MCP Tool，复用现有训练分析链路并返回结构化 `reply`、`summary` 和 `focus`，不会写 Telegram、Markdown 或数据库。
- 新增 MCP 架构方案与使用文档，说明 Tool 边界、配置方式、返回结构和当前不开放的高副作用能力。

### Fixed

- 修复身体反馈 Markdown 日期在 UTC CI 环境中被二次时区转换，导致 `/分析` 快照日期偏移一天的问题。

### Changed

- 同步项目包版本号到 `1.1.6`。

## [1.1.5] - 2026-05-25

### Added

- 新增“身体反馈”随想模块：支持站点 `/body-feedback/` 页面，并通过 Telegram `/随想 身体反馈 内容`、`/thought 身体反馈 内容` 归档锻炼过程中的不适、疼痛、疲劳和恢复异常。
- 支持按既有 ID 方式编辑、删除和移动身体反馈随想，`/移动 <id> 身体反馈` 与 `/随想 <id> 身体反馈` 会同步更新模块和标签。

### Fixed

- 修复 Telegram 训练图片识别在上游返回 `records.details: null` 时整张运动明细图被 schema 校验丢弃的问题，避免 HIIT 等活动明细缺失导致活动次数为 0。
- 修复 Telegram 饮食截图仅识别到餐次热量、未识别到 `totalCalories` 时页面饮食热量显示为空的问题：同步后处理会用餐次热量合计作为兜底总热量。
- 修复 Telegram 训练图片识别在上游返回 `records.details` 为对象或字符串时被本地 schema 校验整体拒绝的问题：识别服务会先归一为字符串数组，再执行严格校验，避免 `missing recognition` 导致图片批次无法入库。
- 修复 Telegram 训练图片识别在 OpenAI 兼容接口不支持 `json_schema` structured output 时被 400 拒绝的问题：保留严格 schema 优先策略，并在兼容性错误时自动降级到 `json_object` 重试，避免 `missing recognition` 导致图片批次无法入库。
- 补充 Telegram 图片识别 `json_object` 降级请求中的小写 `json` 明确提示，兼容要求消息正文必须包含 `json` 关键字的上游接口。

### Changed

- 同步项目包版本号到 `1.1.5`。

## [1.1.4] - 2026-05-25

### Fixed

- 修复 Telegram 训练图片识别在上游 AI 拒绝 Telegram 文件直链时的回退路径：会下载图片并以内联图片数据重试，不影响 `/analysis` 与 `/thought` 的独立分支处理。
- 补充 Telegram 图片识别失败时的上游错误摘要，便于直接从日志定位 400 类识别失败原因。

### Changed

- 同步项目包版本号到 `1.1.4`。

## [1.1.3] - 2026-05-24

### Changed

- 完成中优先级的 M1/M2/M4/M6：统一 AI provider 调用入口，补齐 prompt/schema 版本化，加入默认关闭的图片识别缓存设计，并为数据库读取增加可选时间窗口。
- 生成的识别与分析 prompt 现在会写入版本 metadata，运行时会自动剥离，避免污染模型输入。
- Telegram 识别结果缓存 key 已与 prompt/schema/model 绑定，保证版本变化自动 miss。
- `readTrainingSnapshotFromDatabase` 现在支持 `dateFrom` / `dateTo`，默认行为保持全量兼容。
- 同步项目包版本号到 `1.1.3`。

## [1.1.2] - 2026-05-24

### Changed

- 补充高风险 targeted tests，先锁定 Telegram 命令路由、训练分析意图、数据库事务回滚和 dashboard view model 契约。
- 同步项目包版本号到 `1.1.2`。

## [1.1.1] - 2026-05-24

### Changed

- 优化训练看板指标卡片的数据变化提示样式，使用更明显的底色、边框与状态色提升变化感知。
- 提升首页顶部导航的字号、字重和颜色对比度，增强中文菜单可读性。
- 同步项目包版本号到 `1.1.1`。

## [1.1.0] - 2026-05-24

### Added

- 建立 Keep a Changelog 1.1.0 风格的版本更新日志规范。
- 在页脚展示由 `CHANGELOG.md` 最新发布条目控制的网站版本号，便于后续维护与审计。

## [1.0.0] - 2026-05-24

### Added

- 初始版本：发布训练记录看板、锻炼随想、杂七杂八与关于页面。
- 支持从训练数据生成静态看板和日常记录概览。

[Unreleased]: https://github.com/soulgo/training_records/compare/v1.1.8...HEAD
[1.1.8]: https://github.com/soulgo/training_records/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/soulgo/training_records/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/soulgo/training_records/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/soulgo/training_records/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/soulgo/training_records/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/soulgo/training_records/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/soulgo/training_records/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/soulgo/training_records/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/soulgo/training_records/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/soulgo/training_records/releases/tag/v1.0.0
