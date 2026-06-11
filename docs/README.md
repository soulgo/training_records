# 文档总览

本目录是项目维护文档入口。维护人员应先读 README，再按任务进入对应专题文档。

## 推荐阅读顺序

1. [项目 README](../README.md)
2. [系统总览](系统架构/系统总览.md)
3. [数据流转说明](数据流转/数据流转说明.md)
4. [训练记录生成与解析](训练系统/训练记录生成与解析.md)
5. [Telegram 使用说明](训练系统/Telegram使用说明.md)
6. [Telegram 睡眠识别与入库说明](训练系统/Telegram睡眠识别与入库说明.md)
7. [Telegram 图片日期归档](训练系统/Telegram图片日期归档.md)
8. [Telegram 图片识别 Prompt 维护](训练系统/Telegram图片识别Prompt维护.md)
9. [GitHub 与 Cloudflare 配置](部署维护/GitHub与Cloudflare配置.md)
10. [日常维护手册](部署维护/日常维护手册.md)
11. [Dev 环境搭建步骤](dev_env/dev_environment_implementation.md)
12. [常见问题排查](问题排查/常见问题排查.md)
13. [V10 数据库唯一事实源与 Markdown 备份方案](优化重构/数据库唯一事实源与 markdown 备份_v10/数据库唯一事实源与Markdown备份方案.md)
14. [V11 落地 checklist](优化重构/Telegram同步PostgreSQL提速与OpenAI兼容API_v11/checklist.md)
15. [V12 MCP 删除与数据库结构对齐](优化重构/MCP删除与数据库结构对齐_v12/README.md)
16. [V13 数据统一与六边形架构重构](优化重构/数据统一与六边形架构重构_v13/README.md)

## 文档目录

| 目录 | 内容 |
| --- | --- |
| [系统架构](系统架构/) | 系统总览、内部接口、架构图、模块依赖图 |
| [数据流转](数据流转/) | Markdown、PostgreSQL、Telegram、Hexo、GitHub Pages 的数据链路 |
| [训练系统](训练系统/) | 训练记录格式、Telegram 使用、图片日期归档、随想、分析和 prompt 维护 |
| [dev_env](dev_env/) | Dev Bot、Dev 数据库、Dev Worker 和 Cloudflare Pages 预览环境配置 |
| [部署维护](部署维护/) | GitHub Actions、Cloudflare Worker、本地和线上维护 |
| [模块说明](模块说明/) | AI provider、AI schema 校验等内部模块说明 |
| [问题排查](问题排查/) | 同步、构建、日期、数据库、AI、部署常见问题 |
| [优化重构](优化重构/) | 已实施或待实施的阶段性重构方案、checklist、验收 runbook |
| [更新记录](更新记录/) | 版本记录维护说明 |
| [历史归档](历史归档/) | 已完成或阶段性方案文档，不作为当前操作手册 |

## 当前事实源

- 当前代码行为以源码、测试和工作流为准。
- 文档与代码不一致时，以代码为准，并同步修正文档。
- `训练数据解析.md` 是构建生成的排查输出，不作为长期维护手册。
- `优化重构/` 下的方案、checklist 和 runbook 用于沉淀阶段性改造结论，不替代长期系统文档或源码事实。
- V10/V11 以后，Telegram 图片正常成功路径以数据库增量 upsert 为主；`训练记录.md` 和 `source/_posts` 由 DB -> Markdown 备份派生，不作为成功路径的即时写入目标。
- Telegram 发送锻炼、体脂秤、饮食和睡眠图片的稳定链路，优先看 `训练系统/Telegram使用说明.md`、`训练系统/Telegram图片日期归档.md`、`训练系统/Telegram睡眠识别与入库说明.md`。
- Telegram `/随想` 支持纯文本、图片 caption 和 Markdown 文档附件；Markdown 附件正文最大 5MB，详情见 `训练系统/Telegram使用说明.md` 和 `训练系统/随想模块维护.md`。
- 修改图片识别字段、截图类型或日期口径时，先看 `训练系统/Telegram图片识别Prompt维护.md`，再同步 schema、数据库写入和测试。
- 睡眠数据相关说明优先看 `训练系统/Telegram睡眠识别与入库说明.md`、`训练系统/训练记录生成与解析.md` 与数据库 schema。
- V9 及更早的优化文档保留为历史方案和验收背景；涉及 Markdown fallback、目标日期 Markdown 合并等旧口径时，以 V10/V11/V12/V13 和长期维护文档为准。
- `历史归档/` 下文档只保留背景和方案脉络，日常维护优先阅读其它目录。
