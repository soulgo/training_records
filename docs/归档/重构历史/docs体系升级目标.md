# Goal Document: docs IA upgrade

## Go / No-Go

- **Judgment**: Go
- **Reason**: 用户已明确要求按前次 IA 审阅建议优化文档；本次只改 docs，不改代码、SQL、workflow 或运行行为。

## Target Outcome

`docs/` 形成新的长期信息架构：正式目录承载当前事实，`归档/` 承载历史方案，入口按新人、架构师、开发、运维和 AI Agent 可读路径组织。

## Goal Definition

- **Type**: quality / operational
- **Boundary**: 只迁移、归档和新增文档；不修改功能代码、SQL、prompt 或 workflow。
- **Non-goals**:
  - 不做代码重构。
  - 不做线上配置验证。
  - 不删除历史资料的实质内容。
- **Deferred work**:
  - 逐篇深度合并旧长期文档内容。
  - 自动链接检查脚本。
  - 图形文件重绘。
- **Verification rule**: 新目录存在，入口链接到正式 SSOT，历史重构包移入归档，README 不再推荐旧路径作为首读入口。
- **Evidence source**: `find docs`、`rg`、`git diff --check`、`git status --short`。
- **Pass criteria**: 新 SSOT 目录齐全；`docs/README.md` 指向新体系；`docs/归档/重构历史/` 包含历史重构包；无 diff whitespace error。
- **Confidence note**: 这是文档 IA 级落地，内容为可维护骨架和关键事实提炼，不声称逐字吸收所有旧文档细节。
- **Judgment owner**: 当前工作树和用户验收。

## Current State

- 旧 docs 已有长期文档和大量历史重构包。
- 最新系统认知曾集中在 `docs/优化重构/核心代码优化01/`。
- 正式入口和历史留痕混杂。

## Priority Rationale

- 先移动历史重构包，解除日常入口混乱。
- 再建立新 SSOT 目录，保证有地方承接当前事实。
- 最后更新入口和验证，避免读者继续走旧路径。

## Assumptions and Open Decisions

| Item | Status | Impact | Owner / Next step |
| --- | --- | --- | --- |
| 保留旧长期文档 | assumed | 避免一次性删除造成信息丢失 | 后续逐篇合并后再归档 |
| 历史重构包只归档不删除 | confirmed | 保留审计证据 | 本次执行 |
| 不改代码 | confirmed | 降低风险 | 本次执行 |

## Phases

### Phase 1: 建立 IA 骨架

- **Purpose**: 让 docs 有正式分类和归档分类。
- **Entry condition**: 工作树可写。
- **Phase rules**:
  - 只改 docs。
  - 历史重构包移动到 archive。
- **Todos**:
  - [x] 创建新目录。
  - [x] 移动历史重构包。
  - [x] 写 archive 索引。
- **Exit proof**: `find docs/归档/重构历史 -maxdepth 2 -type d` 可看到历史包。
- **Stop condition**: 发现同名路径冲突或未提交用户改动。

### Phase 2: 写当前事实入口

- **Purpose**: 替换旧 docs 入口。
- **Entry condition**: 新目录存在。
- **Phase rules**:
  - docs README 指向新体系。
  - 归档不作为当前事实入口。
- **Todos**:
  - [x] 重写 `docs/README.md`。
  - [x] 新增 overview、architecture、business、message、ai、database、deployment、development、operations、troubleshooting、reference、ai-agent 文档。
- **Exit proof**: `docs/README.md` 可作为新入口阅读。
- **Stop condition**: 事实与代码证据冲突。

### Phase 3: 验证

- **Purpose**: 确认迁移结果可读且无基础格式错误。
- **Entry condition**: 文档改动完成。
- **Phase rules**:
  - 至少运行 `git diff --check`。
  - 盘点旧路径引用。
- **Todos**:
  - [ ] 运行验证命令。
  - [ ] 修复必要入口链接。
- **Exit proof**: 验证命令通过或明确说明残留。
- **Stop condition**: 出现大量断链需要二次迁移策略。

## Dry-Run Findings

- 一次性删除旧长期文档风险较大，因此本轮保留旧长期文档，先让新 SSOT 成为主入口。
- 历史重构包应归档而非删除。

## Final Validation

```bash
git diff --check
find docs -maxdepth 2 -type f | sort
rg -n "docs/优化重构|优化重构/" README.md docs
```

## First Execution Step

创建新目录并移动历史重构包到 `docs/归档/重构历史/`。
