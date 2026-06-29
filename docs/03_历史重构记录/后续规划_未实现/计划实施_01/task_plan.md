# 任务计划：计划实施 01

## 目标

实施系统健康审计中第一批最高收益修复：同步链路 concurrency 策略决策、dispatch 幂等、Markdown 原子备份、cache purge 误报降级。

## 成功标准

- webhook 触发的 `sync.yml` 是否从唯一 concurrency group 改为稳定 group，先完成与现有测试/设计的冲突决策；若决定改，测试必须同步表达新的串行兜底意图。
- DO 队列在 GitHub `workflow_dispatch` 成功发出后，如果 `findDispatchedRunId` 抛错进入重试，不会因仍处于 `phase: 'dispatch'` 而重复创建同一任务的 workflow run。
- 随想 Markdown 导出不再先删除正式文件后逐个重写；异常中断不会留下可被提交的半成品删除 diff。
- cache purge 失败只影响缓存刷新提示，不影响数据同步、Pages 部署和最终成功通知。
- 相关测试覆盖新增的异常路径，至少包括并发组表达式、DO 重试幂等、Markdown 备份保护和 cache purge 降级。

## 阶段

- [ ] Phase 1：同步链路 concurrency 决策
  - 先确认是否推翻现有测试保护的“webhook dispatch runs use unique concurrency groups while the worker queue controls ordering”设计。
  - 如果决定在 GitHub Actions 层增加串行兜底，再修改 `.github/workflows/sync.yml` / `sync-dev.yml` 的 webhook concurrency group。
  - 同步改写 `test/github-workflows.test.mjs`，让测试明确保护新的设计依据，而不是只补丁式改表达式。

- [ ] Phase 2：DO dispatch 幂等
  - 为队列任务引入可复用 dispatch identity。
  - `dispatchGithubTask` 返回成功后，先持久化 `phase: 'wait_for_run'` 与 `dispatchStartedAt`，再查询 run。
  - `findDispatchedRunId` 抛错后的重试路径必须先复用/查询已有 run，而不是直接再次 dispatch。
  - 覆盖“dispatch 已发生但 `findDispatchedRunId` 抛错”的测试。

- [ ] Phase 3：随想 Markdown 原子备份
  - 先生成到 staging 目录。
  - 校验导出数量、关键 ID、删除数量阈值。
  - 校验通过后再替换正式 `source/_posts` 中的派生随想文件。
  - 更新 `markdown-backup.yml`，避免 export 失败后继续提交异常 diff。

- [ ] Phase 4：cache purge 降级
  - 修改 `.github/workflows/deploy-pages.yml`，将 purge 缺凭证或 API 失败降级为 warning。
  - 保留日志和 step summary，便于排障。
  - 确认 `sync.yml` 不再因 purge 失败触发同步失败通知。

- [ ] Phase 5：回归验证
  - 运行 `npm test` 或覆盖相关区域的最小测试集。
  - 人工检查 workflow YAML 的触发条件、权限和失败传播。
  - 复核本目录的实施清单，确认没有把第二批范围混入本期。

## 实施红线

- 不破坏 Telegram webhook 接入、鉴权、相册缓冲和同步结果通知。
- 不破坏飞书事件接入、图片分组和同步结果通知。
- 不破坏 PostgreSQL `ingest.*`、`core.*`、`archive.*` 现有幂等约束。
- 不改变 Markdown 派生备份和 Hexo 构建输入的最终文件格式。
- 不把 source identity 全链路迁移混入本期。
