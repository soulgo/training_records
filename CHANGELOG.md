# Changelog

本项目所有显著变更都会记录在此文件中。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

维护约定：

- 最新正式版本是第一个形如 `## [x.y.z] - YYYY-MM-DD` 的发布条目；站点页脚版本号从这里自动读取。
- 保留 `## [Unreleased]` 记录尚未发布的显著变更，发布时移动到新的版本条目。
- 版本按时间倒序排列，发布日期使用 `YYYY-MM-DD`。
- 变更类型按需使用 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`；没有内容的分类不保留。

## [Unreleased]

## [1.1.2] - 2026-05-24

### Changed

- 补充高风险 targeted tests，先锁定 Telegram 命令路由、训练分析意图、数据库事务回滚和 dashboard view model 契约。
- 同步项目包版本号到 `1.1.2`。

## [1.1.1] - 2026-05-24

### Changed

- 优化训练看板指标卡片的数据变化提示样式，使用更明显的底色、边框与状态色提升变化感知。
- 提升首页顶部导航的字号、字重和颜色对比度，增强中文菜单可读性。
- 同步项目包版本号到 `1.1.1`。

## [1.1.0] - 2026-05-24

### Added

- 建立 Keep a Changelog 1.1.0 风格的版本更新日志规范。
- 在页脚展示由 `CHANGELOG.md` 最新发布条目控制的网站版本号，便于后续维护与审计。

## [1.0.0] - 2026-05-24

### Added

- 初始版本：发布训练记录看板、锻炼随想、杂七杂八与关于页面。
- 支持从训练数据生成静态看板和日常记录概览。

[Unreleased]: https://github.com/soulgo/training_records/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/soulgo/training_records/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/soulgo/training_records/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/soulgo/training_records/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/soulgo/training_records/releases/tag/v1.0.0
