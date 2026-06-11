# Telegram 随想支持 Markdown 附件显示方案 v14

## 目标

Telegram 发送 `/随想`、`/随想 杂七杂八` 或 `/随想 身体反馈` 时，如果消息附带 `.md` / `.markdown` 文档，系统下载文档内容并作为随想正文写入 `core.thought.body`。后续继续使用现有 DB -> Markdown 导出链路生成 `source/_posts/*telegram-thought-*.md`，由 Hexo 渲染到对应随想页面。

## 范围

- 支持 Telegram document 附件：`.md`、`.markdown`、`text/markdown`，以及文件名为 Markdown 扩展名的 `text/plain`。
- Markdown 附件不进入训练图片识别，也不写入图片引用。
- caption 只负责命令和模块识别；当 caption 正文和 Markdown 附件同时存在时，以 Markdown 附件内容为正文。
- 不新增数据库字段，不新增附件下载卡片，不保存原始 Markdown 文件下载链接。

## 数据流

1. `normalizeTelegramMessage()` 将图片 document 继续归入 `photos`，将 Markdown document 单独归入 `markdownDocuments`。
2. `groupTelegramUpdates()` 看到 `/随想` caption 后生成 `kind: "thought"` batch；即使命令正文为空，只要有 Markdown 附件，也允许进入随想链路。
3. `handleThoughtSyncBatch()` 在持久化前下载第一个 Markdown 附件，按 UTF-8 解码，去除 BOM 并 trim。
4. 解码后的正文覆盖 caption 正文，随后按现有 `persistNormalizedBatch()` 写入 `core.thought.body`。
5. `exportDerivedTrainingMarkdown()` 从数据库导出随想 Markdown，页面继续由 Hexo 渲染 Markdown 正文。

## 失败策略

- 附件声明大小超过 5MB：不下载，不入库，batch 标记为 skipped。
- 下载后内容超过 5MB：不入库，batch 标记为 skipped。
- 下载失败：不入库，`failureCategory` 按 Telegram API 失败分类。
- 解码后为空：不入库，提示 `empty markdown attachment`。
- 没有正文且没有 Markdown 附件：保留原有 `empty thought body` 跳过逻辑。

## 验证

最低验证命令：

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs test/thoughts-page.test.mjs test/training-db-core.test.mjs
```
