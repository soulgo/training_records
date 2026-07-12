# Hai TDD: 训练者画像迁移 SQL

## Target Behavior

在不新建数据库、不覆盖现有 SQL 导出的前提下，提供一份 PostgreSQL 17 迁移：创建最小 `core.trainee_profile`，保存稳定画像输入，不冗余存储年龄、体重、静息心率等动态/可计算数据，并附带角色权限、默认画像和验收查询。

## RED

- **Test added**: `test/trainee-profile-migration.test.mjs`
- **Behavior asserted**: 迁移必须存在并定义表、字段、范围约束、JSON 形状、`default` seed、角色权限和只读验收 SQL；不得新增 `age`/体重/静息心率列。
- **Command**: `node --test test/trainee-profile-migration.test.mjs`
- **Observed failure**: 2 个测试都因 `ENOENT: sql/migration_trainee_profile.sql` 失败。
- **Failure is correct because**: 目标迁移尚未存在，失败直接证明测试约束了本轮需要新增的产物，不是导入、语法或环境错误。

## GREEN

- **Minimal implementation**: 新增 `sql/migration_trainee_profile.sql`，定义 `core.trainee_profile`、最小画像列、`profile_json`、check constraints、`default` seed、`training_app/training_readonly/training_maintenance` 权限、验收查询与回滚说明。
- **Command**: `node --test test/trainee-profile-migration.test.mjs`
- **Observed pass**: 2 tests，2 pass，0 fail。

## REFACTOR

- **Refactor done**: yes
- **Change**: 验收查询必须留在 SQL 注释中，避免 migration 自动执行诊断 SELECT。首次 GREEN 运行暴露测试正则未忽略 `--` 注释前缀；修改测试先规范化文档查询，不改变 SQL 安全性。
- **Command after refactor**: `node --test test/trainee-profile-migration.test.mjs`
- **Observed result**: 2 tests，2 pass，0 fail。

## Next Behavior

执行迁移后，为 `TraineeProfileRepository.loadActive()` 和 `/分析` 单 SQL context 补充新的 RED；该代码接入不属于本轮“提供 SQL 文件”的实施范围。
