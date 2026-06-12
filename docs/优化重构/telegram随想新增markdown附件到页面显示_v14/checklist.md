# Telegram 随想 Markdown 附件 v14 Checklist

## 已覆盖行为

- [x] `.md` document + `/随想` caption 会分组为 `thought` batch。
- [x] `.markdown` / `text/plain` document + 模块 caption 会保留目标模块。
- [x] Markdown document 不进入 `photos`，不会触发训练图片识别。
- [x] 同时存在 caption 正文和 Markdown 附件时，正文以附件内容为准。
- [x] 模块-only caption 可以依赖 Markdown 附件提供正文。
- [x] 空附件、超 5MB 附件、下载失败都会在入库前跳过并保留失败原因。
- [x] 页面能渲染 Markdown 附件导出的标题、列表、代码块和链接。

## 执行验收

- [x] 本地运行 `node --test test/telegram-sync.test.mjs`。
- [x] 本地运行 `node --test test/telegram-sync-runner.test.mjs`。
- [x] 本地运行 `node --test test/thoughts-page.test.mjs`。
- [x] 本地运行 `node --test test/training-db-core.test.mjs`。
- [ ] 真实 Telegram dev Bot 发送 `/随想` + `.md` 文件，确认回执成功。
- [ ] 触发导出/部署后检查 `/thoughts/` 页面显示 Markdown 内容。
