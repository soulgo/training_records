BEGIN;

-- 参数检查历史依赖参数主表，必须先删除。
DROP TABLE IF EXISTS "monitor"."system_config_parameter_checks";
DROP TABLE IF EXISTS "monitor"."system_config_parameters";

-- 兼容序列尚未绑定 OWNED BY 的旧 dev 数据库导出。
DROP SEQUENCE IF EXISTS "monitor"."system_config_parameter_checks_check_id_seq";

COMMIT;
