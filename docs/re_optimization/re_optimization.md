# 系统重构与优化现状

本文档现在作为"重构现状总入口"，记录已经完成、部分完成和仍待办的优化项。领域规则不在这里重复展开，具体口径以各单一事实来源文档为准。

## 当前结论

- 日志检查结果：`deploy.log` 和 `telegram.log` 没有同步或部署失败；全部 146 个测试通过，0 failures。
- 已本轮全部完成：`ws` moderate advisory 已修复（`npm audit fix`，0 vulnerabilities）；所有 CI workflow 统一使用 Node 24 并加固测试断言；Dashboard 趋势图 x 轴稀疏日期标签、hover tooltip 保留完整日期；`/thought` 文本镜像到 PostgreSQL `core.thought`，图片仍保存在本地目录且 DB 只存引用；`/analysis` 请求体已压缩（focus 采用紧凑编码 `w/m/q/p`，policy 文本迁移到 system prompt）；`dashboard.ejs` 中 `buildFallbackDashboardViewModel` 及 7 个死函数已移除，`dashboard.daily?.length` 直接遗留引用已迁移到 `totalArchivedDays`；`telegram-sync.yml` 的 sync/deploy 两个 job 已合并为单一 job，消除了重复 checkout/setup/npm ci；`telegram-sync.mjs` JSON recognition schema 已提取到 `telegram-recognition-schema.mjs`；`training-db-core.mjs`（原 1317 行）已拆分为 config/read/write 三层 + facade；`telegram-sync.mjs`（原 1484 行）已拆分为 transport/thoughts/orchestrator；`/analysis` prompt 已迁移到结构化源 + 生成器架构；Markdown 读取已延迟到首次 fallback/导出时触发；数据库快照读取已改为 4 个独立连接并行查询；pending queue 已加入去重与 1000 条上限治理。

## 不可变约束

- `TrainingSnapshot`、`dashboardView.json`、Markdown 导出文本、Telegram batch result 的现有语义不能在未说明和未验证前改变。
- PostgreSQL 不可用时仍保留 Markdown fallback 与 pending queue 补偿机制。
- `/thought` 继续写 `source/_posts/*.md` 作为 Markdown 兼容层；图片继续写 `source/images/thoughts/`。
- `/thought` 正文、Telegram 元数据、Markdown 路径和有序图片引用镜像到 PostgreSQL；DB 不存图片二进制。
- `/analysis` 只回 Telegram，不写仓库内容，也不写 PostgreSQL。

## 阶段状态

| 阶段 | 状态 | 当前事实 | 仍待办 |
| --- | --- | --- | --- |
| Phase 1：文档固化与低风险清理 | 已完成 | 已有重构总入口；领域文档边界明确；workflow 测试已具备 CRLF 归一化读取；`telegram/` 仅含 `inbox/.gitkeep` 占位文件，无历史运行态文件需清理 | 无 |
| Phase 2：Telegram 快速同步 CI 优化 | 已完成 | `repository_dispatch` 已跳过 backfill/reconcile/export；无内容变更路径已被 workflow 测试覆盖；所有 workflow 统一使用 Node 24 + 测试断言；sync 与 deploy job 已合并为单一 job，消除重复 setup/npm ci | 无 |
| Phase 3：Dashboard view model 收敛 | 已完成 | 图表窗口已限制最近 30 天；每日卡片默认 4 天；x 轴稀疏标签和完整日期 tooltip 已实现；`buildFallbackDashboardViewModel` 及 7 个死函数已移除；`totalArchivedDays` 已通过 `dashboard-view.mjs` 提供，替代 `dashboard.ejs` L195 直接遗留引用；`|| dashboard.*` 回退选择器作为降级安全网保留 | 无 |
| Phase 4：DB 与 Telegram 大文件拆分 | 已完成 | `training-db-core.mjs`（原 1317 行）已拆分为 `training-db-config.mjs`（15 行）、`training-db-read.mjs`（301 行）、`training-db-write.mjs`（917 行）+ facade（104 行）；`telegram-sync.mjs`（原 1484 行）已拆分为 `telegram-transport.mjs`（114 行）、`telegram-thoughts.mjs`（450 行）、`telegram-recognition-schema.mjs`（114 行）+ orchestrator（858 行）；所有现有测试通过，原有导入路径不变 | 无 |
| Phase 5：Prompt 与 token 优化 | 已完成 | 图片识别 prompt 已有单一事实来源和测试；`/analysis` 行为有文档和测试；`/analysis` 请求体已压缩（`JSON.stringify` 去除 pretty 格式化）；Prompt 生成器 `training-prompt.mjs` 已实施：支持动态注入训练目标、从文件读取或使用内置默认 prompt | 无 |
| Phase 6：结构稳定后的性能优化 | 已完成 | Markdown 文件读取已延迟到首次 fallback/导出时触发（避免每次运行都读盘）；pending queue 已加入 batchId 去重和 1000 条上限；数据库快照读取已改为 4 个独立连接并行查询 | 无 |
| Phase 7：Prompt 源重构与 /analysis 请求体压缩 | 已完成 | 新增 `prompts/_source/` 结构化 JSON 源（shared/recognition/analysis 三条源），集中维护共享规则；新增 `tools/prompt-generator.mjs` 生成器编译结构化源到运行时 `prompts/*.md`；focus 对象压缩为 `{w, m, q, p}` 紧凑编码，policy 文本迁移到 system prompt「回答时间窗策略」section；`trainingGoal` 从 user message 移除（已在 system prompt）；新增 `test/prompt-generator.test.mjs`（8 个测试）；维护文档已更新为「改规则只改结构化源」约定 | 无 |

## 单一事实来源

| 规则类型 | 单一事实来源 |
| --- | --- |
| Telegram 日期归档规则 | `docs/telegram-date-resolution.md` |
| 图片识别 prompt 规则 | `prompts/_source/recognition-rules.json` + `prompts/_source/shared-rules.json` |
| `/analysis` prompt 规则 | `prompts/_source/analysis-rules.json` + `prompts/_source/shared-rules.json` |
| Prompt 生成与编译 | `tools/prompt-generator.mjs` |
| 图片识别 prompt 维护 | `docs/telegram-recognition-prompt.md` |
| `/analysis` 行为 | `docs/telegram-analysis.md` |
| `/thought` 行为 | `docs/thoughts-module.md` |
| GitHub secrets/vars | `docs/github-settings.md` |
| Cloudflare webhook | `docs/telegram-webhook-cloudflare.md` |
| Dashboard 派生数据 | `tools/dashboard-view.mjs` 与 `test/dashboard-view.test.mjs`、`test/dashboard-page.test.mjs` |
| Analysis 编排与 compact focus | `tools/training-analysis.mjs` |
| Analysis prompt 加载 | `tools/training-prompt.mjs` |
| DB 配置 | `tools/training-db-config.mjs` |
| DB 读取 | `tools/training-db-read.mjs` |
| DB 写入 | `tools/training-db-write.mjs` |
| Telegram 传输层 | `tools/telegram-transport.mjs` |
| Telegram 随想文件操作 | `tools/telegram-thoughts.mjs` |
| Telegram 识别 schema | `tools/telegram-recognition-schema.mjs` |

## 本轮新增验收点

- CI/CD：`telegram-sync.yml` sync/deploy job 已合并为单一 job，消除重复 checkout/setup/npm ci；TRAINING_DB_* env vars 已提升到 job 级别减少重复声明。
- Dashboard：`totalArchivedDays` 已加入 `dashboard-view.mjs`，`dashboard.ejs` L195 直接引用已迁移。
- 大文件拆分：`training-db-core.mjs`（原 1317 行）拆为 4 个模块；`telegram-sync.mjs`（原 1484 行）拆为 5 个模块。所有现有导入路径通过 facade re-export 保持向后兼容，137 个测试全部通过。
- Prompt 生成器：`tools/training-prompt.mjs` 已实施，`buildTrainingAnalysisPrompt()` 支持动态注入训练目标、从文件读取或使用内置默认 prompt；`loadTrainingAnalysisPrompt()` 作为兼容层保留。
- Prompt 源重构：新增 `prompts/_source/` 结构化 JSON 源（shared/recognition/analysis），`tools/prompt-generator.mjs` 编译生成运行时 `prompts/*.md`。`/analysis` focus 对象压缩为 `{w, m, q, p}` 紧凑编码，policy 文本迁移到 system prompt。
- 性能优化：Markdown 文件读取已延迟到首次 fallback/导出时触发；pending queue 已加入 batchId 去重和 1000 条上限，防止无限增长。
- 依赖安全：`ws` moderate advisory 已通过 `npm audit fix` 修复（0 vulnerabilities）。

## 模块架构

```
tools/
├── training-db-config.mjs      # DB 配置解析（15 行）
├── training-db-read.mjs        # DB 读取操作（301 行）
├── training-db-write.mjs       # DB 写入操作（917 行）
├── training-db-core.mjs        # Facade：re-export + exportTrainingMarkdown（104 行）
├── training-snapshot.mjs       # 快照编排（原有）
├── training-domain.mjs         # 领域模型（原有）
├── training-parser.mjs         # Markdown 解析器（原有）
├── training-analysis.mjs       # 训练分析（原有，focus 已压缩）
├── training-prompt.mjs         # Prompt 加载与目标注入（69 行）
├── prompt-generator.mjs        # Prompt 源编译生成器（128 行）★新增
├── telegram-sync.mjs           # 同步编排器（~830 行）★重构
├── telegram-sync-lib.mjs       # 同步库（1453 行，原有）
├── telegram-transport.mjs      # Telegram API 传输层（114 行）
├── telegram-thoughts.mjs       # 随想 CRUD（450 行）
├── telegram-recognition-schema.mjs  # AI 识别 JSON Schema（114 行）
├── dashboard-view.mjs          # Dashboard 视图模型（原有）
└── ...

prompts/
├── _source/
│   ├── shared-rules.json       # 共享规则（空值、置信度、日期共享）
│   ├── recognition-rules.json  # 识别规则（输出类型、日期、体脂秤、运动、饮食）
│   └── analysis-rules.json     # 分析规则（输出要求、时间窗策略、建议口径）
├── telegram-training-image-recognition.md  # 编译后的运行时 prompt
└── training-analysis.md                    # 编译后的运行时 prompt
```
