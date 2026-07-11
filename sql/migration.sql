-- 通用 AI 截图识别元数据迁移
-- 目标：将高频检索与审计字段从 recognition_json 提升为有类型、可索引的列。
-- 执行前建议：备份 ingest.telegram_recognition，并确认应用已升级到写入新列的版本。

begin;

alter table ingest.telegram_recognition
  add column if not exists source_app text,
  add column if not exists data_type text,
  add column if not exists fields_json jsonb,
  add column if not exists confidence numeric(5,4),
  add column if not exists pipeline_version text,
  add column if not exists ocr_json jsonb,
  add column if not exists image_json jsonb,
  add column if not exists cache_key text;

comment on column ingest.telegram_recognition.source_app is 'AI 识别出的来源应用名称；为空表示无法可靠判断';
comment on column ingest.telegram_recognition.data_type is '标准化数据类型，例如 measurement、workout、nutrition、sleep 或 unknown';
comment on column ingest.telegram_recognition.fields_json is '跨来源标准化后的业务字段，不绑定特定 App 页面布局';
comment on column ingest.telegram_recognition.confidence is '标准化识别置信度，范围 0 到 1';
comment on column ingest.telegram_recognition.pipeline_version is '图片处理、OCR、语义理解与标准化管线版本';
comment on column ingest.telegram_recognition.ocr_json is 'OCR 文本、文本块及坐标证据；未启用 OCR 时为空';
comment on column ingest.telegram_recognition.image_json is '图片格式、尺寸、压缩与质量处理元数据；不保存密钥或原图内容';
comment on column ingest.telegram_recognition.cache_key is '包含来源渠道、文件身份、提示词、Schema 与模型的精确缓存键';

-- 兼容升级前已存在的数据；优先读取 normalizedRecognition，缺失时回退旧识别字段。
update ingest.telegram_recognition
set
  source_app = coalesce(source_app, recognition_json #>> '{normalizedRecognition,sourceApp}', recognition_json->>'detectedApp'),
  data_type = coalesce(data_type, recognition_json #>> '{normalizedRecognition,dataType}', recognition_json->>'imageType', 'unknown'),
  fields_json = coalesce(fields_json, recognition_json #> '{normalizedRecognition,fields}', recognition_json->'records'),
  confidence = coalesce(
    confidence,
    case
      when coalesce(recognition_json #>> '{normalizedRecognition,confidence}', recognition_json->>'confidence')
        ~ '^(0(?:\.\d+)?|1(?:\.0+)?)$'
      then coalesce(recognition_json #>> '{normalizedRecognition,confidence}', recognition_json->>'confidence')::numeric
      else null
    end
  ),
  pipeline_version = coalesce(pipeline_version, recognition_json #>> '{normalizedRecognition,runtime,pipelineVersion}', 'legacy'),
  ocr_json = coalesce(ocr_json, recognition_json #> '{normalizedRecognition,evidence,ocr}'),
  image_json = coalesce(image_json, recognition_json #> '{normalizedRecognition,evidence,image}'),
  cache_key = coalesce(cache_key, recognition_json #>> '{normalizedRecognition,runtime,cacheKey}', recognition_json->>'cacheKey')
where
  source_app is null
  or data_type is null
  or fields_json is null
  or confidence is null
  or pipeline_version is null
  or cache_key is null;

alter table ingest.telegram_recognition
  drop constraint if exists ck_ingest_telegram_recognition_confidence;

alter table ingest.telegram_recognition
  add constraint ck_ingest_telegram_recognition_confidence
  check (confidence is null or (confidence >= 0 and confidence <= 1));

create index if not exists idx_ingest_telegram_recognition_cache_key
  on ingest.telegram_recognition (cache_key)
  where cache_key is not null;

create index if not exists idx_ingest_telegram_recognition_type_updated
  on ingest.telegram_recognition (data_type, updated_at desc);

create index if not exists idx_ingest_telegram_recognition_source_app_updated
  on ingest.telegram_recognition (source_app, updated_at desc)
  where source_app is not null;

commit;

-- 验收查询（迁移提交后人工执行）：
-- select count(*) as invalid_confidence_count
-- from ingest.telegram_recognition
-- where confidence is not null and (confidence < 0 or confidence > 1);
-- explain select recognition_json from ingest.telegram_recognition where cache_key = '<cache-key>' order by updated_at desc limit 1;
--
-- 回滚说明：先部署不再读写新列的旧版本，再执行以下语句；JSON 原始数据不会被本迁移删除。
-- drop index if exists ingest.idx_ingest_telegram_recognition_source_app_updated;
-- drop index if exists ingest.idx_ingest_telegram_recognition_type_updated;
-- drop index if exists ingest.idx_ingest_telegram_recognition_cache_key;
-- alter table ingest.telegram_recognition drop constraint if exists ck_ingest_telegram_recognition_confidence;
-- alter table ingest.telegram_recognition drop column if exists cache_key, drop column if exists image_json,
--   drop column if exists ocr_json, drop column if exists pipeline_version, drop column if exists confidence,
--   drop column if exists fields_json, drop column if exists data_type, drop column if exists source_app;
