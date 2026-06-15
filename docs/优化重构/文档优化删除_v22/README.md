# 文档优化删除 v22

## 目标

把根目录 `README.md` 和 `docs/` 收敛成“当前维护文档 + 少量已实施方案留痕”的结构。当前维护人员应能从根 README 进入 `docs/README.md`，再进入系统架构、数据流转、训练系统、部署维护和问题排查，不需要阅读旧阶段方案即可接手维护。

## 当前问题

- `docs/优化重构/` 保留了大量 v5-v21 阶段方案、checklist 和排查记录，其中不少仍写着旧 workflow、旧 Worker、旧 MCP 或 Markdown fallback 口径。
- 根 README 曾出现本机绝对路径链接，迁移到其它机器或 GitHub 后不可用。
- 部分长期维护文档仍引用已删除或已替换入口，例如 `telegram-sync.yml`、独立飞书 workflow、`wrangler.feishu.toml`、MCP 使用说明和 v9 runbook。
- 小型专题文档分散在长期目录中，维护者需要在多个文件之间跳转才能理解同一个 AI 或 Telegram 行为。

## 保留规则

| 内容 | 处理 | 原因 |
| --- | --- | --- |
| 根 `README.md` | 保留并修正 | 项目入口和快速维护入口 |
| `docs/README.md` | 保留并重建导航 | docs 目录总入口 |
| `docs/系统架构/`、`docs/数据流转/`、`docs/训练系统/`、`docs/部署维护/`、`docs/问题排查/` | 保留 | 当前维护所需长期文档 |
| `docs/dev_env/`、`docs/数据模型规范.md`、`docs/更新记录/` | 保留 | 当前环境、schema 和版本维护仍需要 |
| `docs/优化重构/数据统一与六边形架构重构_v13/` | 保留为已实施留痕 | 当前架构说明仍引用六边形演进背景 |
| `docs/优化重构/新增飞书功能_v18/`、`v19`、`v20`、`docs 文档内容优化_v21/` | 保留为已实施留痕 | 记录飞书接入、main/dev 合并和上轮文档修正背景 |
| `docs/优化重构/文档优化删除_v22/` | 保留 | 本次审核与执行记录 |

## 删除规则

| 内容 | 处理 | 原因 |
| --- | --- | --- |
| `docs/历史归档/` | 删除 | 旧 MCP 和第二轮重构方案已不作为当前维护入口 |
| `docs/优化重构/系统优化重构_v5/` 到 `docs/优化重构/重构优化_v9/` | 删除 | 已被长期文档或后续版本吸收，且包含旧 workflow/Markdown fallback 口径 |
| `docs/优化重构/数据库唯一事实源与 markdown 备份_v10/`、`v11`、`MCP删除与数据库结构对齐_v12/` | 删除 | 核心结论已进入数据流转、数据模型和部署维护文档 |
| `docs/优化重构/telegram随想新增markdown附件到页面显示_v14/`、`自适应图片解析入库_v15/`、`telegram 发送连续分批发送图片报错排查_v16/`、`Cloudflare_CDN代理加速_v17/` | 删除 | 功能已落地，当前维护口径已进入训练系统、问题排查和部署维护文档 |
| `docs/部署维护/dev统一入口GitHub与Cloudflare配置清单.md` | 删除 | dev 配置已合并到 `GitHub与Cloudflare配置.md` |
| `docs/训练系统/AI_BACKUP_SOLUTION.md` | 合并后删除 | 备用 AI 行为归入 AI Provider 文档 |
| `docs/模块说明/AI返回Schema校验.md` | 合并后删除 | schema 校验行为归入 AI Provider 和 Prompt 维护文档 |
| `docs/训练系统/Telegram命令注册表.md` | 合并后删除 | 命令优先级和 Markdown 附件规则归入 Telegram 使用说明 |

## 迁移要求

- 删除前先把当前仍有效的信息合并到长期文档，避免只靠 git history 才能查到维护规则。
- 长期文档不得再把旧入口写成当前事实；保留的已实施方案目录可以继续出现旧入口名称，但只能作为历史背景。
- 文档导航只指向当前维护路径，不再把 v10、v11、v12、v15、v21 等阶段方案放入推荐阅读顺序。
- 本次只改文档，不改代码、SQL、workflow 行为、环境变量语义或生成数据文件。

## 验证命令

长期文档旧入口检查：

```bash
rg -n "telegram-sync\\.yml|telegram-sync-dev\\.yml|feishu-sync\\.yml|feishu-sync-dev\\.yml|wrangler\\.feishu|deploy-cloudflare-feishu-worker|MCP使用说明|/C:/Users" README.md docs/README.md docs/系统架构 docs/数据流转 docs/训练系统 docs/部署维护 docs/问题排查 docs/模块说明
```

保留方案目录旧入口抽样检查：

```bash
rg -n "telegram-sync\\.yml|feishu-sync\\.yml|wrangler\\.feishu|deploy-cloudflare-feishu-worker" docs/优化重构
```

配置事实检查：

```bash
node --test test/github-workflows.test.mjs test/cloudflare-config.test.mjs
```

格式检查：

```bash
git diff --check -- README.md docs
```

## 验收标准

- 根 README 的文档链接均为仓库相对链接。
- `docs/README.md` 的推荐阅读顺序只包含当前维护文档。
- 长期维护文档不再引用已删除的旧方案目录或不存在的 MCP 使用文档。
- 已删除目录不再出现在 `docs/README.md`、部署维护、问题排查或系统架构的当前操作路径中。
- 配置测试和 Markdown diff 检查通过。
