# 系统重构与优化现状

本文档现在作为“重构现状总入口”，记录已经完成、部分完成和仍待办的优化项。领域规则不在这里重复展开，具体口径以各单一事实来源文档为准。

## 当前结论

- 日志检查结果：`deploy.log` 和 `telegram.log` 没有同步或部署失败；原日志里 132 个测试通过，本轮新增覆盖后本地为 134 个测试通过。
- 已本轮完成：Dashboard 趋势图 x 轴稀疏日期标签、hover tooltip 保留完整日期；`/thought` 文本镜像到 PostgreSQL `core.thought`，图片仍保存在本地目录且 DB 只存引用。
- 后续维护项：GitHub Actions Node 20 弃用提示需要迁移到 Node 24；`ws` transitive moderate advisory 需要单独依赖治理。
- 仍未完成：`/analysis` 请求体 pretty JSON 压缩、`dashboard.ejs` 残留 fallback/派生逻辑收敛、workflow Node 24 迁移。

## 不可变约束

- `TrainingSnapshot`、`dashboardView.json`、Markdown 导出文本、Telegram batch result 的现有语义不能在未说明和未验证前改变。
- PostgreSQL 不可用时仍保留 Markdown fallback 与 pending queue 补偿机制。
- `/thought` 继续写 `source/_posts/*.md` 作为 Markdown 兼容层；图片继续写 `source/images/thoughts/`。
- `/thought` 正文、Telegram 元数据、Markdown 路径和有序图片引用镜像到 PostgreSQL；DB 不存图片二进制。
- `/analysis` 只回 Telegram，不写仓库内容，也不写 PostgreSQL。

## 阶段状态

| 阶段 | 状态 | 当前事实 | 仍待办 |
| --- | --- | --- | --- |
| Phase 1：文档固化与低风险清理 | 部分完成 | 已有重构总入口；领域文档边界基本明确；workflow 测试已具备 CRLF 归一化读取 | 确认 `telegram/` 历史运行态文件是否需要 `git rm --cached` |
| Phase 2：Telegram 快速同步 CI 优化 | 部分完成 | `repository_dispatch` 已跳过 backfill/reconcile/export；无内容变更路径已被 workflow 测试覆盖 | 迁移 Actions 到 Node 24；继续减少重复 setup/npm ci |
| Phase 3：Dashboard view model 收敛 | 部分完成 | 图表窗口已限制最近 30 天；每日卡片默认 4 天；本轮已完成 x 轴稀疏标签和完整日期 tooltip | `themes/cactus/layout/dashboard.ejs` 仍有 fallback/派生逻辑，尚未完全收敛到 `tools/dashboard-view.mjs` |
| Phase 4：DB 与 Telegram 大文件拆分 | 待办 | facade 仍集中在 `tools/training-db-core.mjs` 和 `tools/telegram-sync.mjs`；本轮只新增 thought mirror 写入 | 拆分 config/read/write/merge/export、transport/AI/queue/writer/orchestrator |
| Phase 5：Prompt 与 token 优化 | 部分完成 | 图片识别 prompt 已有单一事实来源和测试；`/analysis` 行为有文档和测试 | `tools/training-analysis.mjs` 仍需去掉 pretty JSON 或压缩请求体 |
| Phase 6：结构稳定后的性能优化 | 待办 | 当前同步仍以正确性和 fallback 安全为先 | 按 `archivedDate` 聚合写入、优化 snapshot 读取、延迟 Markdown IO、治理 pending queue |

## 单一事实来源

| 规则类型 | 单一事实来源 |
| --- | --- |
| Telegram 日期归档规则 | `docs/telegram-date-resolution.md` |
| 图片识别 prompt 维护规则 | `docs/telegram-recognition-prompt.md` + `prompts/telegram-training-image-recognition.md` |
| `/analysis` 行为 | `docs/telegram-analysis.md` + `prompts/training-analysis.md` |
| `/thought` 行为 | `docs/thoughts-module.md` |
| GitHub secrets/vars | `docs/github-settings.md` |
| Cloudflare webhook | `docs/telegram-webhook-cloudflare.md` |
| Dashboard 派生数据 | `tools/dashboard-view.mjs` 与 `test/dashboard-view.test.mjs`、`test/dashboard-page.test.mjs` |

## 本轮新增验收点

- Dashboard：短标签数量受控；tooltip 使用完整 `YYYY-MM-DD`；图表数据点仍保留完整 30 天窗口。
- 随想：创建、编辑、删除批次都会写入/更新 `core.thought`；图片仍只保存到本地目录，DB 只保存路径引用。
- 文档：`docs/thoughts-module.md` 已改为“Markdown 兼容层 + DB 文本镜像”的口径。

## 后续推荐顺序

1. 先处理 workflow Node 24 迁移和 `ws` advisory。
2. 压缩 `/analysis` 请求体，补 `test/training-analysis.test.mjs` 覆盖。
3. 把 `dashboard.ejs` 残留派生逻辑继续迁到 `tools/dashboard-view.mjs`。
4. 再拆分 DB 与 Telegram 大文件，保留现有 facade 导出和测试。
