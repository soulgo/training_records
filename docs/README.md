# 文档总览

本目录是项目维护文档入口。维护人员应先读 README，再按任务进入对应专题文档。

## 推荐阅读顺序

1. [项目 README](../README.md)
2. [系统总览](系统架构/系统总览.md)
3. [数据流转说明](数据流转/数据流转说明.md)
4. [数据模型规范](数据模型规范.md)
5. [训练记录生成与解析](训练系统/训练记录生成与解析.md)
6. [Telegram 使用说明](训练系统/Telegram使用说明.md)
7. [Telegram 睡眠识别与入库说明](训练系统/Telegram睡眠识别与入库说明.md)
8. [Telegram 图片日期归档](训练系统/Telegram图片日期归档.md)
9. [Telegram 图片识别 Prompt 维护](训练系统/Telegram图片识别Prompt维护.md)
10. [飞书通道部署](部署维护/飞书通道部署.md)
11. [GitHub 与 Cloudflare 配置](部署维护/GitHub与Cloudflare配置.md)
12. [日常维护手册](部署维护/日常维护手册.md)
13. [Dev 合并 Main 操作手册](部署维护/dev合并main/README.md)
14. [Dev 环境搭建步骤](dev_env/dev_environment_implementation.md)
15. [常见问题排查](问题排查/常见问题排查.md)

## 文档目录

| 目录 | 内容 |
| --- | --- |
| [系统架构](系统架构/) | 系统总览、内部接口、架构图、模块依赖图 |
| [数据流转](数据流转/) | Markdown、PostgreSQL、Telegram、飞书、Hexo、GitHub Pages 的数据链路 |
| [训练系统](训练系统/) | 训练记录格式、消息通道使用、图片日期归档、随想、分析和 prompt 维护 |
| [dev_env](dev_env/) | Dev Bot、Dev 数据库、Dev Worker 和 Cloudflare Pages 预览环境配置 |
| [部署维护](部署维护/) | GitHub Actions、Cloudflare Worker、本地和线上维护 |
| [模块说明](模块说明/) | AI provider 等内部模块说明 |
| [问题排查](问题排查/) | 同步、构建、日期、数据库、AI、部署常见问题 |
| [优化重构](优化重构/) | 已实施方案留痕和本次文档删除记录，不作为日常操作入口 |
| [更新记录](更新记录/) | 版本记录维护说明 |

## 当前事实源

- 当前代码行为以源码、测试和工作流为准。
- 文档与代码不一致时，以代码为准，并同步修正文档。
- `训练数据解析.md` 是构建生成的排查输出，不作为长期维护手册。
- `优化重构/` 下只保留少量已实施方案留痕和 v22 文档删除记录，不替代长期系统文档或源码事实。
- main/dev 的 Telegram 和飞书都进入统一 Cloudflare Worker，再由 `sync.yml` / `sync-dev.yml` 在 GitHub Actions 内判断 channel；飞书通过适配器复用 Telegram 同步主编排、AI 图片识别、随想入库和分析链路，不复制一套业务流程。
- V10/V11 以后，消息通道图片正常成功路径以数据库增量 upsert 为主；`训练记录.md` 和 `source/_posts` 由 DB -> Markdown 备份派生，不作为成功路径的即时写入目标。
- Telegram 发送锻炼、体脂秤、饮食和睡眠图片的稳定链路，优先看 `训练系统/Telegram使用说明.md`、`训练系统/Telegram图片日期归档.md`、`训练系统/Telegram睡眠识别与入库说明.md`。
- Telegram `/随想` 支持纯文本、图片 caption 和 Markdown 文档附件；Markdown 附件正文最大 5MB，详情见 `训练系统/Telegram使用说明.md` 和 `训练系统/随想模块维护.md`。
- GitHub Actions、Cloudflare Worker、Pages、Telegram webhook 和飞书 Request URL 的配置优先看 `部署维护/GitHub与Cloudflare配置.md`；该文档先列参数，再解释用途。
- 飞书发送训练图片、`/随想`、`/帮助` 和 `/分析` 的部署与验收优先看 `部署维护/飞书通道部署.md`；飞书文本随想是 DB-first，不即时生成 Markdown 帖。
- 数据库 core 子表使用 `source_channel` 区分 `telegram`、`feishu`、`markdown_import` 等来源；`core.thought.telegram_message_id` 仍是兼容字段名，飞书会写入稳定数字代理 ID。
- 修改图片识别字段、截图类型、APP Profile 或日期口径时，先看 `训练系统/Telegram图片识别Prompt维护.md`，再同步 schema、批次输出、数据库写入和测试。
- 睡眠数据相关说明优先看 `训练系统/Telegram睡眠识别与入库说明.md`、`训练系统/训练记录生成与解析.md` 与数据库 schema。
- 已删除的旧方案和历史归档不再作为当前维护入口；需要追溯时使用 git history。
- 保留的 v13/v18/v19/v20/v21/v22 只作为已实施背景和审核记录，日常维护以本 README 推荐路径为准。
