# ADR 0004: Markdown 是数据库派生备份

## 决策

正常同步成功后不即时写 Markdown；Markdown 由数据库导出。

## 理由

- 避免图片同步时整日覆盖其它模块。
- Markdown 更适合作为人工可读备份。
- 恢复时需要显式导入和对账。

## 影响

- `ready + stored` 的业务成功不以 Markdown diff 为准。
- `markdown-backup.yml` 的失败不等同于业务数据丢失。
