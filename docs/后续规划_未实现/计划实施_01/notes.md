# 证据笔记：从系统健康审计提取的本期范围

## 提取原则

本期只提取“收益高、风险明确、改动边界相对可控”的项。依据来自 `../系统健康审计/05_最终可信风险清单.md` 和 `../系统健康审计/06_最终验收报告.md`。

没有纳入的风险不是不成立，而是更适合后续单独排期。

## 纳入项证据

### 01. webhook 路径 Action 并发不串行

来源：`../系统健康审计/05_最终可信风险清单.md` P0-1。

代码证据：

- `.github/workflows/sync.yml:37-39` 的 concurrency group 在 webhook dispatch / repository_dispatch 路径为 `sync-<run_id>`。
- `cloudflare/sync-dispatch-queue.mjs:477-480` 注入 `queue_task_id`，webhook 路径一定进入该分支。
- `test/github-workflows.test.mjs:691-711` 明确保护当前设计：webhook dispatch run 使用唯一 concurrency group，排序由 worker queue 控制，并用 `assert.doesNotMatch` 禁止把所有 `repository_dispatch` 放入固定 pending queue。

收益判断：

- 如果决定增加 GitHub Actions 层稳定 group，可直接降低 webhook 多任务并发执行风险。
- 但该项不是单纯补漏，而是与现有测试/设计相冲突的架构决策；实施前必须先明确是否推翻“排序只由 DO 队列负责”的既定测试意图。
- 如暂不推翻现有设计，本期应先暂停该代码改动，只保留风险说明和后续决策项。

### 02. DO 重试路径无幂等键

来源：`../系统健康审计/05_最终可信风险清单.md` P0-2。

代码证据：

- `cloudflare/sync-dispatch-queue.mjs:175-203` 重试保留 `phase: 'dispatch'`。
- `continueProcessing` 中正常“查不到 run”路径会写入 `phase: 'wait_for_run'` 和 `dispatchStartedAt`，不会立刻重复 dispatch。
- 真正漏洞是 `dispatchGithubTask` 成功后，后续 `findDispatchedRunId` 抛错进入 catch；catch 调用 `retryOrDeadLetter(processing, error)` 时传入的仍是旧 `processing`，重试持久化后仍为 `phase: 'dispatch'`。
- 下次 alarm 会再次进入 `continueProcessing` 并调用 `dispatchGithubTask`。
- `cloudflare/sync-dispatch-queue.mjs:369-385` 调用 GitHub `workflow_dispatch` API 时没有幂等键。

收益判断：

- 解决“GitHub 已创建 run，但 DO 在查询 run 阶段异常”导致的重复 dispatch 窗口。
- 与 Item 01 是否改稳定 concurrency group 无强绑定；即使维持当前唯一 group 设计，DO 侧也应先消除同任务重复 dispatch。

### 03. 随想 Markdown 备份先删后写

来源：`../系统健康审计/05_最终可信风险清单.md` P0-4。

代码证据：

- `tools/export-training-markdown.mjs:143` 先删除现有派生随想文件。
- `tools/export-training-markdown.mjs:162` 后写入新文件。
- `.github/workflows/markdown-backup.yml:97-105` 会提交 diff，无法区分完整重写和异常中断造成的删除 diff。

收益判断：

- 避免 DB 异常、进程中断或磁盘错误后把“已删除未重写”的状态提交到仓库。
- 对数据安全和站点内容可信度收益很高。

### 04. Pages cache purge 失败使整条链路报失败

来源：`../系统健康审计/05_最终可信风险清单.md` P1-4。

代码证据：

- `.github/workflows/deploy-pages.yml:121-125` 和 `:130-131` purge 失败/缺配置时硬 `exit 1`。
- `.github/workflows/sync.yml:537-538` 将 deploy workflow 非成功判定为失败。
- `.github/workflows/sync.yml:548-561` 进而通知同步失败。

收益判断：

- 数据已入库且 Pages 已部署时，不再因为缓存刷新失败误报“同步失败”。
- 改动小、收益确定，适合放在本期。

## 本期排除项

### P0-3：同日 `core.training_day` 来源追踪

仍成立，但涉及数据模型语义：`training_day` 是日汇总事实还是审计索引。建议后续与 source identity 统一一起设计。

### P1-1 / P1-2：双通道 source identity 全链路统一

仍成立，且长期收益高。但它横跨 DB 写入、随想定位、导出命名、缓存读取和兼容字段，不适合混入本期可靠性修复。

### P1-5 / P1-6：AI 总预算与低置信度 fallback

仍成立，但需要定义成本上限、低置信度阈值、重试次数和用户通知策略。建议单独做 AI 质量专项。

### P2 类治理项

schema migration 化、`ai_call_log` 可靠写入、主 Worker 自动部署、wrangler 命名更偏工程治理。可以后续整理，不应挤占本期可靠性修复。
