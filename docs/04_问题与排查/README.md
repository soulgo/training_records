# 问题与排查

本目录按统一模板整理运行问题。排查步骤只基于当前代码、workflow、SQL 和日志字段。

## 文档列表

| 文档 | 主题 |
| --- | --- |
| `PostgreSQL.md` | 数据库连接、schema、写入、快照问题。 |
| `OSS.md` | 腾讯云 COS / 本地随想图片存储问题。 |
| `Telegram.md` | Telegram webhook、授权、下载、通知问题。 |
| `飞书.md` | 飞书事件校验、图片下载、回执问题。 |
| `AI.md` | AI provider、schema、fallback、缓存问题。 |
| `Action日志.md` | GitHub Actions summary、失败步骤、业务未完成问题。 |
| `部署.md` | Worker、Pages、GitHub Pages、Cloudflare 缓存问题。 |
| `资源.md` | CPU、内存、并发、下载大小和超时问题。 |

## 统一模板

每篇文档使用：

- 现象
- 原因
- 日志特征
- 排查步骤
- 解决方案
- 预防措施
