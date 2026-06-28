# 实施指南：计划实施 01

## 01. webhook sync concurrency 策略决策

### 目标

先决定是否让 webhook dispatch / repository_dispatch 路径在 GitHub Actions 层也具备串行兜底。当前代码使用每个 run 唯一的 `sync-<run_id>`，且现有测试明确保护“排序由 worker queue 控制”的设计；直接改稳定组会与测试和设计决策冲突。

### 建议改动

- 先审阅并改写 `test/github-workflows.test.mjs:691-711` 的测试意图：
  - 如果继续坚持“worker queue controls ordering”，则不要在本期修改 concurrency group，只记录 P0-1 风险接受条件。
  - 如果决定增加 GitHub Actions 层兜底，则删除/改写禁止固定 queue 的断言，并补充新的设计说明。
- 若决定修改，更新 `.github/workflows/sync.yml` 和 `.github/workflows/sync-dev.yml` 的 `concurrency.group`。
- webhook dispatch 可使用稳定且按环境隔离的组名，例如：
  - `sync-main-webhook`
  - `sync-dev-webhook`
  - 或按分支/环境区分：`sync-${{ github.ref_name }}-webhook`
- 保留手动/push 路径固定 `sync` / `sync-dev` 或明确区分为可理解的稳定组。

### 验收

- 决策记录明确说明是否推翻“唯一 concurrency group + DO 排序”的现有测试保护。
- 若决定改稳定组：webhook dispatch 带 `queue_task_id` 时，两个 run 的 concurrency group 相同；手动触发和 push 触发仍符合原有预期。
- `test/github-workflows.test.mjs` 覆盖新的表达式和设计意图，不能继续保留与新实现相反的断言。

## 02. DO dispatch 重试增加幂等保护

### 目标

当 `dispatchGithubTask` 已经让 GitHub 创建 workflow run，但 `findDispatchedRunId` 因网络、HTTP 或响应解析异常抛错进入重试时，不重复创建同一任务的 workflow run。

### 建议改动

- 为每个队列任务使用稳定 dispatch identity，优先复用现有 `task.id` / `queue_task_id`。
- 在 `dispatchGithubTask` 成功返回后，立即把状态从 `phase: 'dispatch'` 推进到 `phase: 'wait_for_run'`，并持久化 `dispatchStartedAt`；之后再调用 `findDispatchedRunId`。
- 重试时如果已有 `dispatchStartedAt` 或已进入 `wait_for_run`，先调用 `findDispatchedRunId`，不要直接再次 dispatch。
- 如 GitHub API 支持的信号不足，则用 workflow inputs 中的 `queue_task_id` 查询 run，确保同一 task 只绑定一个 run。

### 验收

- 单测覆盖：第一次 dispatch 成功，随后 `findDispatchedRunId` 抛错；下次 alarm 不应再次调用 dispatch API。
- 单测覆盖：找不到 run 时进入 wait/retry，最终能绑定到后续出现的 run。
- dead-letter 和通知逻辑仍按最大重试次数工作。

## 03. 随想 Markdown 备份原子化

### 目标

导出随想 Markdown 时，不让正式目录经历“删除完成但新文件未写完”的可提交状态。

### 建议改动

- 在 `tools/export-training-markdown.mjs` 中新增 staging 流程：
  - 读取 DB 后先生成完整目标文件列表。
  - 写入临时目录，例如 `source/.tmp-thought-export-*`。
  - 校验导出数量、文件名唯一性、关键 source/message identity。
  - 校验通过后再替换正式派生随想文件。
- 替换时尽量缩短正式目录处于不完整状态的窗口。
- 删除阈值保护：
  - 如果本次会删除大量现有随想文件，但导出数量明显异常，则失败退出。
  - 阈值可先保守，例如导出数量为 0 且现有派生文件大于 0 时拒绝替换。
- 更新 `.github/workflows/markdown-backup.yml`：
  - export 失败时不得继续进入 commit。
  - commit 前可增加一次异常删除检查。

### 验收

- 模拟写入中途失败，正式 `source/_posts` 不应出现净删除状态。
- 导出数量为 0 且已有派生随想文件时，命令失败并不提交。
- 正常导出后文件名、front matter、Hexo 构建输入保持兼容。

## 04. Pages cache purge 失败降级为 warning

### 目标

cache purge 失败只影响缓存刷新，不把数据同步、构建和 Pages 部署误报为失败。

### 建议改动

- 修改 `.github/workflows/deploy-pages.yml`：
  - purge API 失败时输出 `::warning`，不要 `exit 1`。
  - 缺少 zone/token 时输出 `::warning`，不要阻断 deploy。
  - 将失败详情写入 step summary。
- 确认 `.github/workflows/sync.yml` 轮询 deploy workflow 时，只因真正部署失败而失败。

### 验收

- purge token 缺失时，deploy workflow 仍可成功。
- purge API 5xx 时，deploy workflow 仍可成功并留下 warning。
- sync workflow 不再发送“同步失败”通知，只保留 cache purge warning。

## 最小回归命令

优先运行：

```bash
npm test
```

如全量测试耗时过长，至少运行覆盖以下区域的测试：

```bash
node --test test/github-workflows.test.mjs
node --test test/sync-dispatch-worker.test.mjs
node --test test/export-training-markdown.test.mjs
```

如果缺少对应测试文件，应在实施时补齐或调整为现有最接近的测试入口。
