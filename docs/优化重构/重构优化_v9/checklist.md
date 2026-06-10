# 重构优化 V9 编码 Checklist

本 checklist 用于后续按 V9 优化建议逐段编码和验收。每完成一段代码，如果满足对应验收标准，就勾选该项。

状态约定：

- `[ ]` 未开始
- `[x]` 已完成并验证
- `[~]` 编码中或部分完成

## P0：Markdown 导出一致性

- [x] P0-1 补齐 `exportTrainingMarkdown()` 的睡眠段落渲染。
  - 目标：数据库 snapshot 全量导出时能写出 `#### 当日睡眠截图记录`。
  - 验收：导出的 Markdown 包含睡眠类型、入睡/起床、总睡眠、深睡/浅睡/REM、睡眠评分、健康指标、解读和建议。
  - 建议测试：`node --test test/export-training-markdown.test.mjs test/training-parser.test.mjs`

- [x] P0-2 补齐 `exportTrainingMarkdown()` 的饮食餐次明细渲染。
  - 目标：数据库全量导出不再删除已有 `##### 餐次明细`。
  - 验收：含 `nutrition.details` 的 snapshot 导出后，Markdown 中保留每条 detail。
  - 建议测试：`node --test test/export-training-markdown.test.mjs test/training-parser.test.mjs`

- [x] P0-3 建立导出再解析闭环测试。
  - 目标：`exportTrainingMarkdown(snapshot)` 输出能被 `parseTrainingRecord()` 读回关键字段。
  - 验收：sleep health metrics、sleep stage detail、nutrition details 不丢失。
  - 建议测试：新增 targeted test 后运行 `node --test test/export-training-markdown.test.mjs test/training-parser.test.mjs`

## P0：Telegram 图片增量持久化

- [x] P0-4 保留 `persistNormalizedBatch()` 外部接口并拆出图片增量写入内部路径。
  - 目标：不影响现有调用方，只改变 Telegram 图片成功批次的内部持久化策略。
  - 验收：随想、Markdown 导入、archive 回填路径行为不变。
  - 建议测试：`node --test test/training-db-core.test.mjs test/telegram-sync-runner.test.mjs`

- [x] P0-5 `ingest.*` 写入保持事务内幂等。
  - 目标：`telegram_batch/message/recognition` 继续先写审计层，相同 `batch_id + payload_hash` 返回 `unchanged`。
  - 验收：重复 batch 不重复写 core；失败时事务 rollback。
  - 建议测试：`node --test test/training-db-core.test.mjs`

- [x] P0-6 `core.measurement` 改为本批次 upsert。
  - 目标：体脂秤补发只新增或更新对应 measurement，不删除同日其它模块。
  - 验收：同日已有 activity/meal/sleep 时，补发 measurement 后仍存在。
  - 建议测试：`node --test test/training-db-core.test.mjs`

- [x] P0-7 `core.activity` 改为本批次 upsert。
  - 目标：运动补发只新增或更新对应 activity，不删除同日其它模块。
  - 验收：同日已有 measurement/meal/sleep 时，补发 activity 后仍存在。
  - 建议测试：`node --test test/training-db-core.test.mjs`

- [x] P0-8 `core.meal` 改为本批次 upsert。
  - 目标：饮食补发只新增或更新对应 meal，并正确维护 `nutrition_details_json`。
  - 验收：同日已有 sleep 和 activity 时，补发 nutrition 后不被清空。
  - 建议测试：`node --test test/training-db-core.test.mjs test/telegram-sync-runner.test.mjs`

- [x] P0-9 `core.sleep` 改为本批次 upsert。
  - 目标：睡眠补发只新增或更新对应 sleep，不删除同日饮食、体脂、运动。
  - 验收：单张 sleep 图入库后 `core.sleep` 和 `core.training_day` 睡眠汇总都更新。
  - 建议测试：`node --test test/training-db-core.test.mjs test/telegram-sync.test.mjs`

- [x] P0-10 新增当前 `archivedDate` 的 `core.training_day` 单日汇总刷新。
  - 目标：子表增量写入后，只重算目标日期汇总字段。
  - 验收：活动数量、训练热量、饮食热量、睡眠汇总、nutrition details 均符合现有语义。
  - 建议测试：`node --test test/training-db-core.test.mjs`

- [x] P0-11 明确整日替换只保留给 Markdown 导入、archive 回填和手工对账。
  - 目标：正常 Telegram 图片成功路径不再调用整日删除重建作为主路径。
  - 验收：相关测试能区分 Telegram 增量路径和 Markdown 整日替换路径。
  - 建议测试：`node --test test/training-db-core.test.mjs test/reconcile-training-markdown-to-core.test.mjs`

## P0：Telegram 成功后 Markdown 策略

- [x] P0-12 调整 `runTelegramSync()` 成功写库后的 Markdown 更新策略。
  - 目标：正常 `ready + stored` 图片批次不再默认全量导出整份 `训练记录.md`。
  - 验收：需要更新人工账本时，只对本批次目标日期做 `applyTelegramSyncToMarkdown()` 增量合并。
  - 建议测试：`node --test test/telegram-sync-runner.test.mjs`

- [x] P0-13 保留数据库失败 fallback Markdown。
  - 目标：数据库写入失败时，继续写 `训练记录.md` 并追加 pending 队列。
  - 验收：fallback 行为和现有通知语义不变。
  - 建议测试：`node --test test/telegram-sync-runner.test.mjs test/telegram-sync.test.mjs`

- [x] P0-14 保持 Telegram 图片日期归档逻辑完全不变。
  - 目标：重构只改写入方式，不改 `archivedDate` 决策。
  - 验收：普通图片、相册、文件名回退、冲突跳过、睡眠醒来日期减一天测试全部通过。
  - 建议测试：`node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs`

## P1：状态可观测性

- [x] P1-1 将 workflow 通知 step 改为中性命名。
  - 目标：避免 `Notify Telegram sync success` 被误读为业务完全成功。
  - 验收：main/dev workflow 使用类似 `Notify Telegram sync result` 的名称。
  - 建议测试：`node --test test/github-workflows.test.mjs`

- [x] P1-2 增加 Telegram Sync GitHub Actions summary。
  - 目标：无需展开 JSON，就能看到 batch 状态和失败摘要。
  - 验收：summary 包含 batchId、taskStatus、persistenceStatus、archivedDate、图片计数、pending 状态和失败 messageIds。
  - 建议测试：`node --test test/telegram-sync-runner.test.mjs test/github-workflows.test.mjs`

- [x] P1-3 保持 Telegram 回执对 partial failure / queued retry / resolved replay 的清晰表达。
  - 目标：用户能从回执区分完全成功、部分成功、待重试和补偿成功。
  - 验收：`recognizedImageCount`、`failedImageCount`、`recognitionPendingStatus` 相关用例通过。
  - 建议测试：`node --test test/telegram-sync-notify.test.mjs test/telegram-sync-runner.test.mjs`

## P1：构建与部署降噪

- [x] P1-4 减少 Telegram Sync 与 shared `site-build` 的重复 `npm ci`。
  - 目标：Telegram Sync 已安装依赖时，进入 shared action 不重复安装。
  - 验收：普通 deploy workflow 仍会安装依赖，Telegram Sync site build 可跳过重复安装。
  - 建议测试：`node --test test/github-workflows.test.mjs`

- [x] P1-5 处理 dev Pages Wrangler 部署噪音。
  - 目标：减少每次动态安装和 Pages 输出目录 warning。
  - 验收：dev workflow 日志不再反复出现同类 warning。
  - 建议测试：`node --test test/cloudflare-config.test.mjs test/github-workflows.test.mjs`

- [x] P1-6 关注 GitHub Actions Node deprecation。
  - 目标：提前升级相关 action 版本，避免后续平台切换导致失败。
  - 验收：workflow 测试确认 action 配置仍合法。
  - 建议测试：`node --test test/github-workflows.test.mjs`

## P1/P2：大代码文件拆分治理

- [x] 高优先级 H1 拆分 `src/db/training/write.mjs` 的 DB 写入职责。
  - 目标：将 Telegram 图片增量写入、core 子表 upsert、单日汇总刷新、archive sleep 写入/回填按职责拆开。
  - 验收：`src/db/training/write.mjs` 保留原对外导出入口；Telegram 图片入库、Markdown 导入、archive 回填行为不变。
  - 建议测试：`node --test test/training-db-core.test.mjs test/reconcile-training-markdown-to-core.test.mjs`

- [x] 高优先级 H2 拆分 `tools/telegram-sync-lib.mjs` 的 Telegram 辅助职责。
  - 目标：按 update 分组、日期归档、Markdown section 渲染、batch report 辅助拆分，降低单文件维护成本。
  - 验收：`analyzeTelegramBatch()`、`applyTelegramSyncToMarkdown()` 等既有导出保持兼容；日期归档逻辑完全不变。
  - 建议测试：`node --test test/telegram-sync.test.mjs`

- [x] 高优先级 H3 拆分 `tools/telegram-sync.mjs` 的同步编排职责。
  - 目标：将 pending replay、图片处理、fallback Markdown、通知/结果持久化从主流程中按职责抽出。
  - 验收：`runTelegramSync()` 和 CLI 入口保持兼容；数据库失败 fallback、partial failure、pending replay 行为不变。
  - 建议测试：`node --test test/telegram-sync-runner.test.mjs test/telegram-sync-notify.test.mjs`

- [x] 中优先级 M1 评估并拆分 `src/mcp/tools.mjs`。
  - 目标：按训练快照、每日记录、分析、配置/状态等 MCP tool 主题拆分。
  - 验收：MCP tool 名称、参数、返回结构不变。
  - 建议测试：`node --test test/mcp-tools.test.mjs`

- [x] 中优先级 M2 评估并拆分 `tools/training-analysis.mjs`。
  - 目标：拆出 intent 解析、上下文构造、AI 回复生成和 Telegram 分段发送。
  - 验收：`/分析` 命令行为、提示词输入和回执语义不变。
  - 建议测试：`node --test test/training-analysis.test.mjs test/telegram-sync-runner.test.mjs`

- [x] 中优先级 M3 评估并拆分 `src/db/training/read.mjs`。
  - 目标：拆出 core 读取、archive 读取、row 到 snapshot 映射，减少读库模块负担。
  - 验收：`readTrainingSnapshotFromDatabase*`、`readArchiveTrainingSnapshotFromDatabase*` 导出兼容。
  - 建议测试：`node --test test/training-snapshot.test.mjs test/training-db-core.test.mjs`

- [x] 低优先级 L1 分批整理 `test/telegram-sync-runner.test.mjs`。
  - 目标：按 ready stored、fallback、pending replay、通知、命令类批次拆分测试或抽共享 fixture。
  - 验收：测试语义不变，失败时能更快定位场景。
  - 建议测试：`node --test test/telegram-sync-runner.test.mjs`

- [x] 低优先级 L2 分批整理 `test/telegram-sync.test.mjs`。
  - 目标：按日期归档、Markdown 合并、图片计数、partial failure 分组。
  - 验收：普通图片日期、文件名回退、睡眠醒来日期减一天、冲突跳过用例全部保留。
  - 建议测试：`node --test test/telegram-sync.test.mjs`

- [x] 低优先级 L3 分批整理 `test/training-db-core.test.mjs`。
  - 目标：按 persist、import/export、backfill、sleep 等主题整理测试。
  - 验收：DB 事务、rollback、幂等、sleep 回填和 Markdown 导入测试不丢失。
  - 建议测试：`node --test test/training-db-core.test.mjs`

- [x] 拆分安全规则检查。
  - 目标：避免机械按行数拆分或新增大量薄包装文件。
  - 验收：每次拆分都有明确职责边界；原 facade/barrel 导出保持兼容；相关 targeted tests 通过。
  - 建议测试：按拆分范围运行对应 targeted tests，并最终运行 `npm run test:fast`

## P2：可选审计增强

- [x] P2-1 评估是否需要 `ingest` 层增量审计 SQL。
  - 目标：只在 JSON 审计不够排查时新增 SQL，不强制改主表。
  - 验收：形成是否新增 `sql/training_records/telegram_incremental_audit.sql` 的结论。
  - 建议测试：只读评估，无需代码测试。

- [x] P2-2 如新增 SQL，确保代码无 SQL 也能兼容。
  - 目标：新增字段只做审计加速，不参与核心功能判断。
  - 验收：未执行 SQL 的测试环境仍通过全部 targeted tests。
  - 建议测试：`node --test test/training-db-core.test.mjs test/telegram-sync-runner.test.mjs`

- [ ] P2-3 如新增审计字段，补充文档和 SQL 说明。
  - 目标：维护者知道 SQL 何时执行、执行前后行为差异是什么。
  - 验收：`docs/训练系统/` 或 `docs/部署维护/` 中有对应说明。
  - 建议测试：文档检查和 `npm run test:fast`
  - 当前：本轮未新增审计字段或增量 SQL，条件未触发，保持未勾。

## 最终验收

- [x] V9-1 全部 P0 targeted tests 通过。
  - 目标：核心数据写入和 Markdown 可见性风险已消除。
  - 验收：P0 相关测试命令无失败。
  - 建议测试：`node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs test/training-db-core.test.mjs test/export-training-markdown.test.mjs test/training-parser.test.mjs`

- [x] V9-2 `npm run test:fast` 通过。
  - 目标：快速回归无明显行为破坏。
  - 验收：命令退出码为 0。
  - 建议测试：`npm run test:fast`

- [~] V9-3 手工核对真实 Telegram 场景。
  - 目标：确认自动链路不仅单测通过，也符合日常使用。
  - 验收：单张 sleep、1-4 张相册、partial failure replay、数据库 fallback 均按预期。
  - 建议测试：在 dev Bot / dev workflow 上发送真实样例图片。
  - 当前：已补充 `真实Telegram场景验收Runbook_v9.md` 作为人工验收步骤和证据模板；真实 dev Bot / dev workflow 尚未执行。

- [x] V9-4 更新 `CHANGELOG.md`。
  - 目标：实现完成后记录本轮显著变更。
  - 验收：`Unreleased` 中写明增量入库、Markdown 导出一致性和 workflow 状态表达优化。
  - 建议测试：`node --test test/changelog-version.test.mjs`
