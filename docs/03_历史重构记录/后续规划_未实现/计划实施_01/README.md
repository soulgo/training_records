# 计划实施 01：同步可靠性与备份安全

本目录从 `../系统健康审计/` 中提取第一批最值得实施的内容，目标是优先修复生产链路中收益最高、改动相对可控的问题。

## 本期目标

把系统从“核心链路可用，但异常路径依赖单点兜底”推进到：

- webhook 同步是否需要 GitHub Actions 层串行兜底先完成设计决策，不再绕过现有测试直接改 concurrency group。
- Durable Object 在 `workflow_dispatch` 已发出但 run 查询异常时，不会因保留 `phase: 'dispatch'` 而重复创建同一同步任务。
- 随想 Markdown 备份具备原子替换和提交前异常保护。
- Pages cache purge 失败不再把已成功的数据同步误报为失败。

## 本期纳入范围

| 编号 | 来源风险 | 本期实施项 | 收益 |
|---|---|---|---|
| 01 | P0-1 | webhook sync concurrency 策略决策与测试改写 | 避免与现有“唯一 group 由 DO 排序”测试保护冲突 |
| 02 | P0-2 | DO dispatch 后 run 查询异常路径幂等保护 | 降低重复 workflow run 风险 |
| 03 | P0-4 | 随想 Markdown 备份改为临时目录生成、校验、原子替换 | 避免“已删除未重写”被提交 |
| 04 | P1-4 | Pages cache purge 失败降级为 warning | 减少数据成功但通知失败的误报 |

## 本期不纳入

以下风险仍成立，但不放入 `计划实施_01`，避免本期范围过大：

- P0-3：同日 `core.training_day` 来源追踪。
- P1-1 / P1-2：source identity 全链路统一与识别缓存 join。
- P1-3：飞书复用 telegram 命名链路。
- P1-5 / P1-6：AI 单批全局预算与低置信度 fallback。
- P2：schema migration 化、`ai_call_log` 可靠化、Worker 自动部署、wrangler 命名。

## 推荐阅读顺序

1. `task_plan.md`：本期阶段、执行顺序和完成标准。
2. `notes.md`：从系统健康审计提取的证据、收益判断和排除项。
3. `implementation_guide.md`：后续编码时按项实施的检查清单。
