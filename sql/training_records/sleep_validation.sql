-- ------------------------------------------------------------
-- 训练睡眠数据校验脚本
-- 作用：快速检查 core.sleep / archive.training_sleep / archive.training_day 的一致性
-- ------------------------------------------------------------

-- 1. 查看最近有睡眠明细的归档日期
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
  d.awake_minutes,
  count(s.sleep_key) as core_sleep_rows
from core.training_day d
left join core.sleep s on s.archived_date = d.archived_date
where d.archived_date >= current_date - interval '30 days'
group by d.archived_date
order by d.archived_date desc;

-- 2. 检查 core.sleep 是否存在孤儿记录（理论上不应出现）
select
  s.archived_date,
  s.sleep_key,
  s.sleep_type,
  s.bedtime,
  s.wake_time,
  s.total_sleep_minutes,
  s.night_sleep_minutes
from core.sleep s
left join core.training_day d on d.archived_date = s.archived_date
where d.archived_date is null
order by s.archived_date desc, s.updated_at desc;

-- 3. 检查 archive.training_sleep 是否与 archive.training_day 保持同日
select
  s.archived_date,
  s.sleep_hash,
  s.sleep_type,
  s.bedtime,
  s.wake_time,
  s.total_sleep_minutes,
  s.night_sleep_minutes
from archive.training_sleep s
left join archive.training_day d on d.archived_date = s.archived_date
where d.archived_date is null
order by s.archived_date desc, s.updated_at desc;

-- 4. 检查同一天睡眠字段是否有明显冲突
select
  d.archived_date,
  d.sleep_total_minutes,
  sum(coalesce(s.total_sleep_minutes, 0)) as summed_sleep_total_minutes,
  d.night_sleep_minutes,
  sum(coalesce(s.night_sleep_minutes, 0)) as summed_night_sleep_minutes,
  d.deep_sleep_minutes,
  sum(coalesce(s.deep_sleep_minutes, 0)) as summed_deep_sleep_minutes,
  d.light_sleep_minutes,
  sum(coalesce(s.light_sleep_minutes, 0)) as summed_light_sleep_minutes,
  d.rem_sleep_minutes,
  sum(coalesce(s.rem_sleep_minutes, 0)) as summed_rem_sleep_minutes,
  d.awake_minutes,
  sum(coalesce(s.awake_minutes, 0)) as summed_awake_minutes
from core.training_day d
left join core.sleep s on s.archived_date = d.archived_date
group by d.archived_date
having
  coalesce(d.sleep_total_minutes, -1) <> coalesce(sum(s.total_sleep_minutes), -1)
  or coalesce(d.night_sleep_minutes, -1) <> coalesce(sum(s.night_sleep_minutes), -1)
  or coalesce(d.deep_sleep_minutes, -1) <> coalesce(sum(s.deep_sleep_minutes), -1)
  or coalesce(d.light_sleep_minutes, -1) <> coalesce(sum(s.light_sleep_minutes), -1)
  or coalesce(d.rem_sleep_minutes, -1) <> coalesce(sum(s.rem_sleep_minutes), -1)
  or coalesce(d.awake_minutes, -1) <> coalesce(sum(s.awake_minutes), -1)
order by d.archived_date desc;
