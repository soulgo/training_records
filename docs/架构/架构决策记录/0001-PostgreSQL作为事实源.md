# ADR 0001: PostgreSQL 作为事实源

## 决策

训练、饮食、体脂、睡眠、随想等主数据以 PostgreSQL `core.*` 为事实源。

## 理由

- 支持结构化查询和分析。
- 支持 pending、审计和恢复。
- 避免 Markdown 合并导致的同日模块覆盖。

## 影响

- 页面构建和 `/analysis` 优先读取数据库。
- Markdown 作为备份和显式导入入口。
- 任何绕过数据库直接修改事实的方案都需要单独 ADR。
