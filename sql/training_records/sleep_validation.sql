-- ------------------------------------------------------------
-- 训练睡眠数据校验脚本
-- 作用：快速检查 core.training_day 中睡眠字段的一致性与缺失情况
-- 说明：当前库里没有单独的 core.sleep 表，这里只检查按天汇总字段
-- ------------------------------------------------------------

-- 1. 查看最近 30 天的睡眠字段概况
select
  d.archived_date,
  d.sleep_total_minutes,
  d.night_sleep_minutes,
  d.nap_minutes,
  d.sleep_start_time,
  d.sleep_end_time,
  d.deep_sleep_minutes,
  d.light_sleep_minutes,
  d.rem_sleep_minutes,
  d.awake_minutes
from core.training_day d
where d.archived_date >= current_date - interval '30 days'
order by d.archived_date desc;

-- 2. 查找睡眠字段明显不完整的日期
select
  d.archived_date,
  d.sleep_total_minutes,
  d.night_sleep_minutes,
  d.nap_minutes,
  d.sleep_start_time,
  d.sleep_end_time,
  d.deep_sleep_minutes,
  d.light_sleep_minutes,
  d.rem_sleep_minutes,
  d.awake_minutes
from core.training_day d
where d.archived_date >= current_date - interval '30 days'
  and (
    d.sleep_total_minutes is null
    or d.night_sleep_minutes is null
    or d.sleep_start_time is null
    or d.sleep_end_time is null
  )
order by d.archived_date desc;

-- 3. 查找睡眠总时长与夜间睡眠时长明显冲突的日期
select
  d.archived_date,
  d.sleep_total_minutes,
  d.night_sleep_minutes,
  d.nap_minutes,
  d.sleep_start_time,
  d.sleep_end_time,
  d.deep_sleep_minutes,
  d.light_sleep_minutes,
  d.rem_sleep_minutes,
  d.awake_minutes
from core.training_day d
where d.archived_date >= current_date - interval '30 days'
  and d.sleep_total_minutes is not null
  and d.night_sleep_minutes is not null
  and abs(coalesce(d.sleep_total_minutes, 0) - coalesce(d.night_sleep_minutes, 0)) > 60
order by d.archived_date desc;
