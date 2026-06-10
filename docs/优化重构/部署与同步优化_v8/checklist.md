# 第八轮优化检查清单

> 用途：用于后续逐项对照、验证和勾选，方便查阅优化进度。
>
> 使用建议：每完成一项，就将其从 `待办` 移到 `进行中`、`待验证` 或 `已完成`，并在备注里补充简短说明。

---

## 状态说明

- `待办`：尚未开始
- `进行中`：已经开始实施，尚未完全确认
- `待验证`：代码已改完，等待测试或观察
- `已完成`：已验证通过并可长期保留
- `已回滚`：曾实施但后续撤回

---

## 1. 总体目标

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 统一第八轮优化的范围与目标 | 已完成 | 已按 P0 优先落地部署慢步骤按需跳过与 Telegram Sync 审计字段统一 |
| 明确部署链路、Telegram Sync、维护脚本三条主线 | 已完成 | 已分别落地部署门禁、Telegram 报告审计字段和维护脚本统一入口 |
| 保持业务口径不变，仅做结构与效率优化 | 已完成 | 本轮未改变训练记录、随想写入或识别口径 |
| 保留回滚路径，不做不可逆重构 | 已完成 | `site-build` 保留 `sync_db_mode: always/never/auto`，可强制恢复原同步行为 |

---

## 2. 部署与构建优化

### 2.1 链路收敛

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 将重复的 build / sync / deploy 流程收敛到公共逻辑 | 已完成 | `site-build` 公共 action 继续承载 Node、缓存、按需 `sync:db`、快测试、构建与 Pages 部署 |
| 区分不同 workflow 场景的环境差异与执行策略 | 已完成 | main/dev Pages 部署共享 `site-build`，通过 `run_backfill`、`sync_db_mode`、`run_tests`、`deploy` 区分策略 |
| 减少主部署链路中不必要的慢步骤 | 已完成 | `sync:db` 在 `auto` 模式下无数据相关变更时跳过 |
| 将“仅在变化时执行”的逻辑落到 workflow 中 | 已完成 | 已在 `.github/actions/site-build/action.yml` 增加数据库同步输入变更检测 |

### 2.2 数据同步与回填

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 验证数据回填步骤是否已支持快速跳过 | 已完成 | `sync:db` 由 `sync_db_needed` 门禁控制，无数据相关变更时不执行 |
| 验证 Markdown 对账是否避免重复执行 | 已完成 | Markdown 对账仍收敛在 `sync:db` 内，随 `sync_db_mode: auto` 一起按需跳过 |
| 验证数据库连接与事务次数是否减少 | 已完成 | `syncTrainingCore` 复用同一个数据库 client 处理 archive 与 markdown 阶段，已有测试覆盖 |
| 确认无新数据时不会进入完整慢流程 | 待验证 | 本地 workflow 测试已覆盖门禁逻辑；真实 GitHub Actions 耗时需后续观察 |

### 2.3 缓存与测试

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 确认 Hexo 缓存稳定命中 | 待验证 | workflow 已配置 Hexo 缓存；命中率需真实 Actions 运行观察 |
| 确认 Node 依赖缓存正常 | 待验证 | workflow 已使用 `actions/setup-node` 的 npm cache；命中率需真实 Actions 运行观察 |
| 快测试与完整测试已分层 | 已完成 | 公共构建 action 与 CI 使用 `npm run test:fast`，本轮回归通过 |
| 慢测试已迁移到独立触发方式或夜间任务 | 已完成 | `ci-tests.yml` 新增 `full-test` job，仅在 `schedule` 或 `workflow_dispatch` 跑 `npm test` |

---

## 3. Telegram Sync 重构

### 3.1 任务模型

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 统一 batch / task 的状态定义 | 已完成 | `buildTelegramSyncReport()` 新增 `taskStatus`，由现有 batch、落库和重试状态统一派生 |
| 明确 queued / processing / ready / stored / skipped / deferred / partialFailure / resolved / failed 的含义 | 已完成 | `telegram_sync_refactor.md` 已逐项定义；`buildTelegramSyncReport exposes the canonical sync task statuses` 覆盖 9 个规范状态 |
| replay 与首次处理共用同一核心处理逻辑 | 已完成 | 首次图片处理与 pending recognition replay 共用 `buildImageProcessingBatch()`；`runTelegramSync uses the normalized runtime env for first-time and replayed image recognition` 覆盖同一 runtime env |
| 每个任务都能追踪 taskId / batchId / sourceId | 已完成 | 报告新增 `taskId`、`sourceType`、`sourceId`、`retryCount`、`messageIds`、`updateIds` |

### 3.2 失败与补偿

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| partial failure 有统一处理语义 | 已完成 | partial failure 在报告中规范为 `taskStatus: partialFailure`，并保留识别数量与失败明细 |
| 可自动重试与需人工介入的失败类型已分开 | 已完成 | 报告新增 `failureDisposition`，区分 `auto_retry`、`manual_intervention`、`skip` |
| pending / replay 闭环稳定可用 | 已完成 | pending fallback、pending recognition 成功重放和重放失败继续排队均有测试覆盖 |
| 通知文本能清楚表达 `x/N`、失败原因和重试状态 | 已完成 | 通知测试覆盖 `已识别 x/N`、失败原因、失败图片入队重试等文本 |

### 3.3 日志与审计

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| batch、message、recognition、persist 的结果能串起来查 | 已完成 | 报告同时输出 `batchId`、`messageIds`、`updateIds`、识别数量、落库状态与重试状态 |
| 日期来源在日志或报告中可追踪 | 已完成 | 继续保留 `dateSources` 字段，并由新增任务字段补充定位 |
| 失败 messageId 能快速定位 | 已完成 | 报告保留 `recognitionErrors`，并新增批次级 `messageIds` |
| 任务状态变化在审计记录中清晰可见 | 已完成 | 报告新增 `taskStatus` 与 `retryState` |

---

## 4. 维护脚本收敛

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| inspect / sync / migrate 三类命令边界清楚 | 已完成 | 新增 `maintenance:inspect`、`maintenance:sync`、`maintenance:migrate` 三类入口 |
| 只读排查与改数据脚本已严格区分 | 已完成 | `inspect` 只读；`sync` 与确认后的 `migrate` 才会调用同步写入 |
| 维护脚本支持 dry-run 或 confirm 机制 | 已完成 | `maintenance:migrate` 无 `--dry-run` 或 `--confirm` 时返回 `blocked` |
| 重复脚本入口已减少 | 已完成 | 旧 `backfill/reconcile/import/export` npm scripts 已转发到 `tools/training-maintenance.mjs`；旧工具文件保留为兼容模块 |
| 关键维护流程有统一说明文档 | 已完成 | 新增 `maintenance_scripts.md` 说明命令边界、安全规则和后续收敛方向 |

---

## 5. 文档与可查阅性

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 总览文档与子文档内容一致 | 已完成 | `re_optimization_v8.md` 已建立子文档索引；`v8 overview documents the local document index and historical replacements` 覆盖 |
| 部署、Telegram Sync、维护流程都能快速定位 | 已完成 | 部署与 Telegram 仍在分文档；维护流程新增 `maintenance_scripts.md` |
| 新增规则已同步到文档 | 已完成 | 已将维护入口、dry-run/confirm 规则和 checklist 状态同步到 v8 目录 |
| 旧文档若已过期，已标注替代关系 | 已完成 | v8 总览已标注 `构建性能优化_v7`、`图片识别优化_v6`、`系统优化重构_v5` 为历史参考及当前接续文档 |
| 目录结构清晰，后续查阅方便 | 已完成 | v8 总览列出 `re_optimization_v8.md`、`deploy_and_build.md`、`telegram_sync_refactor.md`、`maintenance_scripts.md`、`checklist.md` 的职责 |

---

## 6. 验证与回归

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 普通提交的部署耗时下降 | 待验证 | 已落地 `sync_db_mode: auto` 与快/完整测试分层；真实耗时下降需后续 Actions 数据确认 |
| 无变化提交能够快速跳过慢流程 | 待验证 | 已有 workflow 测试覆盖 `no_data_changes` 门禁；真实耗时需 Actions 验证 |
| Telegram 同步的成功/失败/重放路径通过验证 | 已完成 | `npm run test:fast` 覆盖 Telegram 成功、失败、pending replay、partial failure 路径 |
| 日期冲突、缺失、补发场景覆盖完整 | 已完成 | 测试覆盖日期冲突 skip、缺失日期 skip、文件名/同相册补日期与 pending replay |
| 关键优化项都有对应测试或检查方式 | 已完成 | 新增/更新 workflow 与 Telegram report 测试，`npm run test:fast` 通过 |

---

## 7. 完成记录

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 部署与构建链路收敛 | 已完成 | 本轮完成 `site-build` 自动数据库同步门禁与 main/dev Pages 参数统一 |
| 数据同步与回填优化 | 已完成 | `sync:db` 支持无数据变更快速跳过 |
| Hexo 缓存与测试分层 | 已完成 | 快测试用于常规 CI/部署，完整测试已迁移到手动/定时 job；缓存命中率仍需 Actions 观察 |
| Telegram Sync 任务化重构 | 已完成 | 报告层统一 `taskStatus`/`failureDisposition` 与任务审计字段；图片处理/replay 共用核心逻辑；核心处理器完全任务化留作后续迭代 |
| partial failure 语义统一 | 已完成 | 报告层统一 `partialFailure` 状态并保留失败图片/识别统计 |
| 维护脚本收敛 | 已完成 | 新增统一维护入口和说明文档；旧入口兼容保留 |
| 文档同步与结构整理 | 已完成 | 已更新本 checklist，并新增维护脚本文档 |
| 回归测试与验证完成 | 已完成 | `npm run test:fast` 通过 306 项测试 |
