/*
 图片资产表 thought_image 建表脚本

 对应文档：docs/后续规划_未实现/图片oss存储/02_架构与实施设计.md（第二阶段资产表）

 用途
 - 记录每张图片的对象级元数据：归属随想、存储 provider、bucket、object key、公有读 URL。
 - 支撑未来「孤儿对象清理 / 对象级迁移审计 / hash 去重 / 跨 workflow 失败恢复」。
 - 第一阶段随想图片仍由 core.thought.image_refs_json 承载最终 URL；本表为第二阶段对象治理用。

 前置依赖
 - 已存在 core.thought 表（主键为 source_channel + source_chat_id + source_message_id）。
 - 已存在 core schema。

 风格说明
 - 沿用 sql/training_records/core.sql 的 Navicat 风格：DROP → CREATE → COMMENT → 分段 Indexes/Primary Key/Foreign Keys。
 - 所有字段中文注释。

 执行方式
 - 在 PostgreSQL 17（training_records 库）执行。
 - 可重复执行（DROP TABLE IF EXISTS）。
*/

-- ----------------------------
-- Table structure for thought_image
-- ----------------------------
DROP TABLE IF EXISTS "core"."thought_image";
CREATE TABLE "core"."thought_image" (
  "image_id" serial4 NOT NULL,
  "thought_source_channel" text COLLATE "pg_catalog"."default" NOT NULL,
  "thought_source_chat_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "thought_source_message_id" text COLLATE "pg_catalog"."default" NOT NULL,
  "position" int4 NOT NULL DEFAULT 1,
  "source_channel" text COLLATE "pg_catalog"."default",
  "source_chat_id" text COLLATE "pg_catalog"."default",
  "source_message_id" text COLLATE "pg_catalog"."default",
  "original_file_id" text COLLATE "pg_catalog"."default",
  "storage_provider" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'tencent_cos'::text,
  "bucket" text COLLATE "pg_catalog"."default",
  "region" text COLLATE "pg_catalog"."default",
  "object_key" text COLLATE "pg_catalog"."default",
  "public_url" text COLLATE "pg_catalog"."default",
  "content_type" text COLLATE "pg_catalog"."default",
  "size_bytes" int8,
  "content_hash" text COLLATE "pg_catalog"."default",
  "etag" text COLLATE "pg_catalog"."default",
  "upload_status" text COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'uploaded'::text,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  "deleted_at" timestamptz(6)
)
;

-- ----------------------------
-- Comments for thought_image（字段中文注释）
-- ----------------------------
COMMENT ON TABLE "core"."thought_image" IS '随想图片资产表；记录每张图片的对象级元数据，支撑孤儿对象清理、迁移审计与去重';
COMMENT ON COLUMN "core"."thought_image"."image_id" IS '图片资产自增主键';
COMMENT ON COLUMN "core"."thought_image"."thought_source_channel" IS '所属随想来源通道（外键之一），对应 core.thought.source_channel';
COMMENT ON COLUMN "core"."thought_image"."thought_source_chat_id" IS '所属随想来源会话 ID（外键之一），对应 core.thought.source_chat_id';
COMMENT ON COLUMN "core"."thought_image"."thought_source_message_id" IS '所属随想来源消息 ID（外键之一），对应 core.thought.source_message_id';
COMMENT ON COLUMN "core"."thought_image"."position" IS '该图片在随想图片数组中的序号，从 1 开始，与 image_refs_json 顺序对齐';
COMMENT ON COLUMN "core"."thought_image"."source_channel" IS '图片本身来源通道（通常与所属随想一致，预留单独记录）';
COMMENT ON COLUMN "core"."thought_image"."source_chat_id" IS '图片本身来源会话 ID';
COMMENT ON COLUMN "core"."thought_image"."source_message_id" IS '图片本身来源消息 ID';
COMMENT ON COLUMN "core"."thought_image"."original_file_id" IS '外部平台原始文件 ID，如 Telegram file_id、飞书 image_key，便于回溯下载';
COMMENT ON COLUMN "core"."thought_image"."storage_provider" IS '存储 provider 标识，当前固定 tencent_cos；历史本地图片可记 github_local';
COMMENT ON COLUMN "core"."thought_image"."bucket" IS 'COS 存储桶名（含 APPID），如 training-images-prod-1250000000';
COMMENT ON COLUMN "core"."thought_image"."region" IS 'COS 桶所属地域，如 ap-shanghai';
COMMENT ON COLUMN "core"."thought_image"."object_key" IS 'COS 对象 key，如 main/thoughts/2026/06/2026-06-13-telegram-thought-570-1.jpg；清理孤儿对象的依据';
COMMENT ON COLUMN "core"."thought_image"."public_url" IS '最终公有读 URL，应与 core.thought.image_refs_json 中对应项一致；未备案域名阶段使用 COS 默认域名，如 https://training-images-prod-1250000000.cos.ap-shanghai.myqcloud.com/main/thoughts/...';
COMMENT ON COLUMN "core"."thought_image"."content_type" IS '图片 MIME 类型，如 image/jpeg、image/png';
COMMENT ON COLUMN "core"."thought_image"."size_bytes" IS '图片字节数';
COMMENT ON COLUMN "core"."thought_image"."content_hash" IS '图片内容哈希（如 sha256），用于内容级去重；第一阶段可空，按需回填';
COMMENT ON COLUMN "core"."thought_image"."etag" IS 'COS 返回的对象 ETag，用于校验上传一致性';
COMMENT ON COLUMN "core"."thought_image"."upload_status" IS '上传状态：uploaded 已上传 / pending 待重试 / failed 失败；成功落库后应为 uploaded';
COMMENT ON COLUMN "core"."thought_image"."created_at" IS '资产记录创建时间';
COMMENT ON COLUMN "core"."thought_image"."updated_at" IS '资产记录最后更新时间';
COMMENT ON COLUMN "core"."thought_image"."deleted_at" IS '软删除时间；为空表示有效，非空表示图片已不再被引用（孤儿对象候选）';

-- ----------------------------
-- Indexes structure for thought_image
-- ----------------------------
-- 按随想定位该随想下全部图片（常用查询：随想详情、image_refs_json 重建）
CREATE INDEX "idx_core_thought_image_thought_identity" ON "core"."thought_image" USING btree (
  "thought_source_channel" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "thought_source_chat_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "thought_source_message_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- 按 object_key 反查（孤儿对象清理：列出 COS 全部对象后反查归属）
CREATE INDEX "idx_core_thought_image_object_key" ON "core"."thought_image" USING btree (
  "object_key" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- 按 upload_status 筛选待重试 / 失败（跨 workflow 失败恢复）
CREATE INDEX "idx_core_thought_image_upload_status" ON "core"."thought_image" USING btree (
  "upload_status" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- 按 content_hash 去重查询（第二阶段内容级去重）
CREATE INDEX "idx_core_thought_image_content_hash" ON "core"."thought_image" USING btree (
  "content_hash" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- 同一随想同一位置只允许一条有效记录（防止重复入库）
CREATE UNIQUE INDEX "ux_core_thought_image_thought_position" ON "core"."thought_image" USING btree (
  "thought_source_channel" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "thought_source_chat_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "thought_source_message_id" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "position" "pg_catalog"."int4_ops" ASC NULLS LAST
);

-- ----------------------------
-- Primary Key structure for thought_image
-- ----------------------------
ALTER TABLE "core"."thought_image" ADD CONSTRAINT "thought_image_pkey" PRIMARY KEY ("image_id");

-- ----------------------------
-- Foreign Keys structure for thought_image
-- ----------------------------
-- 外键指向 core.thought 复合主键；随想软删除（status=deleted）时保留图片记录用于审计，故 ON DELETE NO ACTION
ALTER TABLE "core"."thought_image" ADD CONSTRAINT "thought_image_thought_identity_fkey" FOREIGN KEY ("thought_source_channel", "thought_source_chat_id", "thought_source_message_id") REFERENCES "core"."thought" ("source_channel", "source_chat_id", "source_message_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
