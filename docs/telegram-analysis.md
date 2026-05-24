# Telegram 训练分析指令

这份文档说明 Telegram `/analysis` / `/分析` 指令的当前实现口径。它用于临时问答式训练建议，不写 `docs/`，不写数据库，也不提交仓库内容。

## 1. 指令入口

支持两种命令：

```text
/analysis 今天怎么练
/分析 最近饮食怎么样
```

如果命令后没有问题，系统会使用默认问题：

```text
请根据最近训练、体脂、饮食数据给出今天/明天的训练建议
```

系统默认长期目标是：

```text
增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。
```

所有 `/analysis` / `/分析` 回复都会围绕这个目标取舍；比如训练建议优先保证力量训练、恢复和蛋白质，而不是单纯追求更高消耗或更快掉秤。可通过 `TRAINING_ANALYSIS_GOAL` 覆盖这个目标。

普通文本不会触发分析；只有 `TELEGRAM_ALLOWED_CHAT_IDS` 白名单内的 chat 会被处理。

## 2. 数据来源

分析基于现有 `TrainingSnapshot`：

- `TRAINING_SNAPSHOT_SOURCE=markdown` 时读取 `训练记录.md`
- `TRAINING_SNAPSHOT_SOURCE=database` 时读取 PostgreSQL `core.*`
- database 不可用时，是否回退取决于现有 snapshot 构建逻辑

分析模块会汇总最近 7 天和 30 天的：

- 训练频率、训练消耗、锻炼时长
- 骑行里程和活动类型
- 摄入热量
- 体重、体脂率、骨骼肌量趋势
- 最近 5 天概要

系统会根据用户问题推断主时间窗：

- 用户问“最近一周 / 近 7 天”时，主结论只使用最近 7 天与最近 7 次体测趋势
- 用户问“最近 30 天 / 一个月”时，主结论才使用 30 天趋势
- 用户同时点名 7 天和 30 天时，可以对比，但回复里的数字必须标注对应时间窗
- 用户只问“今天/明天怎么练”时，默认以最近 7 天负荷和最近 5 天细节判断恢复与训练安排

系统也会根据用户问题推断回答类型：

- 训练安排：给出训练类型、时长、强度和恢复注意事项
- 饮食：聚焦摄入、蛋白质、餐次规律和训练量匹配
- 体脂/体重趋势：聚焦体重、体脂、骨骼肌和减脂方向
- 恢复疲劳：聚焦连续训练、高负荷、睡眠和主动恢复
- 疼痛/不适：按教练 + 分诊建议回答，结合近期训练负荷与动作细节，但不做医学诊断
- 综合复盘：围绕原问题取舍，不机械罗列所有模块

## 3. 输出规则

系统会调用 AI 生成适合 Telegram 阅读的短回复，并通过 `sendMessage` 回发到原 chat，优先回复到原始指令消息。

## 3.1 Prompt 源文件

分析 prompt 的**单一事实来源**是结构化源文件：

- `prompts/_source/shared-rules.json` — 共享规则（空值约定等）
- `prompts/_source/analysis-rules.json` — 分析特有规则（输出要求、时间窗策略、建议口径）

运行时 prompt `prompts/training-analysis.md` 由生成器编译产出：

```bash
node tools/prompt-generator.mjs
```

**维护规则：改规则只改 `prompts/_source/` 下的 JSON 源，不直接手写 `prompts/training-analysis.md`。**

回复约束由编译后的 `prompts/training-analysis.md` 控制：

- 纯文本
- 控制在 Telegram 友好的长度
- 按用户问题类型组织回复，不固定套用段落模板
- 不编造缺失数据
- 不做医疗诊断
- 疼痛/不适类问题要说明可能训练诱因、当天处理建议和就医红旗
- 严格遵守用户指定的时间窗，避免把一周问题回答成 30 天复盘
- 不承诺“局部减脂”或“快速瘦腹”，而是围绕总体减脂、腰围变化、力量训练、有氧、饮食和恢复给建议

如果回复超过 Telegram 单条消息安全长度，系统会自动拆分为多条发送。

## 4. 与截图同步和 `/thought` 的区别

`/analysis` 批次：

- 不走图片识别
- 不写 `训练记录.md`
- 不写 `source/_posts`
- 不写 PostgreSQL
- 不进入 pending replay 队列
- 只生成一次 Telegram 回复

截图批次和 `/thought` 批次仍保持原有行为。

## 5. 相关实现文件

- `prompts/_source/analysis-rules.json` — 分析 prompt 结构化源
- `prompts/_source/shared-rules.json` — 共享规则源
- `prompts/training-analysis.md` — 编译后的运行时 prompt
- `tools/prompt-generator.mjs` — prompt 生成器
- `tools/training-analysis.mjs` — 分析编排（含 compact focus 格式）
- `tools/training-prompt.mjs` — prompt 加载与目标注入
- `tools/telegram-sync-lib.mjs`
- `tools/telegram-sync.mjs`
- `test/training-analysis.test.mjs`
- `test/prompt-generator.test.mjs`
- `test/telegram-sync-runner.test.mjs`

## 6. 环境变量

当前入口沿用 `npm run sync:telegram` 的统一环境变量校验，至少需要：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_URL`

可选：

- `TRAINING_ANALYSIS_GOAL`：覆盖默认长期目标，例如阶段性改为“维持肌肉、减脂、恢复膝盖压力”

如果 `TRAINING_SNAPSHOT_SOURCE=database`，还需要确保 PostgreSQL 可访问并包含 `core.*` 数据。

## 7. 验证方法

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

线上验证：

1. 给 Bot 发送 `/analysis 今天怎么练`
2. 在 GitHub Actions 确认 `Telegram Sync` 被触发
3. 确认 Telegram 收到分析回复
4. 确认本次不会产生 `训练记录.md`、`source/_posts` 或 `docs/` 同步提交

## 8. 建议口径参考

`prompts/training-analysis.md` 的训练建议口径参考这些稳定来源：

- [CDC 成人活动建议](https://www.cdc.gov/physical-activity-basics/guidelines/adults.html)：每周至少 150 分钟中等强度有氧，外加每周 2 天肌力训练
- [Mayo Clinic 力量训练建议](https://www.mayoclinic.org/healthy-lifestyle/fitness/basics/strength-training/hlv-20049447)：不要连续两天训练同一肌群；力量训练有助于降低体脂、增加瘦体重
- [ISSN 蛋白质立场声明](https://jissn.biomedcentral.com/articles/10.1186/s12970-017-0177-8)：多数运动人群每日蛋白质摄入约 1.4-2.0 g/kg 有助于训练适应和维持肌肉
- [ACSM 成人超重与肥胖活动共识](https://journals.lww.com/acsm-tj/fulltext/2024/10000/physical_activity_and_excess_body_weight_and.1.aspx)：体重管理不依赖单一运动模式，建议结合有氧、抗阻等多模式活动；HIIT 不应被写成比中高强度持续活动更优的默认方案
- [Mayo Clinic 腹部脂肪建议](https://www.mayoclinic.org/health/belly-fat/MC00054)：腹部训练可以强化腹肌，但单靠腹部动作不能消除腹部脂肪，应通过整体饮食和运动降低总体体脂
