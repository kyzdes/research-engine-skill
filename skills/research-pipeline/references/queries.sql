-- Запросы research-pipeline для db_query к базе research (проект Research). ?1 — slug задачи.
-- Блоки разделены строкой «-- name: <имя>»; в db_query уходит один блок целиком, params: ["<slug>"].

-- name: funnel
-- Воронка
SELECT
  count(*)                                                    AS registered,
  sum(sampled)                                                AS sampled,
  sum(stage IN ('screened','processed','done'))               AS screened_in,
  sum(stage IN ('processed','done'))                          AS processed,
  sum(stage IN ('processed','done') AND relevance = 'yes')    AS useful,
  sum(stage = 'done')                                         AS written,
  sum(stage = 'parked')                                       AS parked
FROM assessments WHERE task = ?1

-- name: sample
-- Случайная выборка по группам
WITH pool AS (
  SELECT a.item, s.strategy || '/' || s.tool AS grp,
         row_number() OVER (PARTITION BY s.strategy, s.tool ORDER BY random()) AS rn,
         count(*)     OVER (PARTITION BY s.strategy, s.tool)                   AS grp_size
  FROM assessments a JOIN searches s ON s.id = a.found_by
  WHERE a.task = ?1 AND a.stage = 'candidate'
),
total AS (SELECT count(*) AS n FROM pool),
quota AS (SELECT max(10, min(30, n / 10)) AS q FROM total)
SELECT item, grp FROM pool, total, quota
WHERE rn <= max(CASE WHEN grp_size >= 10 THEN 3 ELSE 0 END,
                CAST(round(q * 1.0 * grp_size / n) AS INTEGER))

-- name: quality
-- Точность, калибровка, полнота
SELECT
  sum(sampled AND relevance = 'yes')                                    AS sample_yes,
  sum(sampled AND relevance IN ('yes','partial','no'))                  AS sample_judged,
  sum(user_label IS NOT NULL)                                           AS user_labeled,
  sum(user_label IS NOT NULL AND user_label = relevance)                AS user_agrees,
  (SELECT count(*) FROM json_each((SELECT known_items FROM tasks WHERE slug = ?1)))   AS known_total,
  (SELECT count(*) FROM json_each((SELECT known_items FROM tasks WHERE slug = ?1)) k
     JOIN assessments a2 ON a2.task = ?1 AND a2.item = k.value
     JOIN searches s2 ON s2.id = a2.found_by AND s2.strategy <> 'manual')            AS known_found
FROM assessments WHERE task = ?1

-- name: batches
-- Доля полезного по партиям
SELECT batch, count(*) AS n, sum(relevance = 'yes') AS yes,
       round(100.0 * sum(relevance = 'yes') / count(*), 1) AS yes_pct
FROM assessments WHERE task = ?1 AND batch IS NOT NULL
GROUP BY batch ORDER BY batch

-- name: saturation
-- Насыщение поиска
SELECT sum(results) AS results, sum(new_unique) AS new_unique,
       round(100.0 * sum(new_unique) / max(sum(results), 1), 1) AS novelty_pct
FROM (SELECT results, new_unique FROM searches WHERE task = ?1 ORDER BY _id DESC LIMIT 5)

-- name: yield
-- Выход и перекос по источникам поиска
SELECT s.strategy, s.tool, coalesce(s.parent_item, '') AS parent,
       count(*)                                   AS found,
       round(100.0 * count(*) / (SELECT count(*) FROM assessments WHERE task = ?1), 1) AS share_pct,
       sum(a.relevance = 'yes')                   AS useful,
       sum(a.decision = 'applied')                AS applied
FROM assessments a JOIN searches s ON s.id = a.found_by
WHERE a.task = ?1
GROUP BY s.strategy, s.tool, s.parent_item
ORDER BY found DESC

-- name: conflicts
-- Противоречия
SELECT f.item, f.attribute, count(DISTINCT f.value) AS variants,
       group_concat(f.value || ' ← ' || f.source || ' (' || coalesce(f.level, '?') || ', '
                    || coalesce(f.observed_at, 'без даты') || ')', ' | ') AS facts
FROM facts f JOIN assessments a ON a.item = f.item AND a.task = ?1
GROUP BY f.item, f.attribute HAVING count(DISTINCT f.value) > 1

-- name: below_bar
-- Поля ниже требуемого уровня
WITH need AS (
  SELECT json_extract(j.value, '$.name') AS attribute, json_extract(j.value, '$.evidence') AS evidence
  FROM tasks t, json_each(t.schema) j WHERE t.slug = ?1 AND json_extract(j.value, '$.evidence') <> 'none'
),
lv(level, r) AS (VALUES ('claimed',1),('observed',2),('corroborated',3),('verified',4)),
best AS (
  SELECT f.item, f.attribute, max(lv.r) AS r FROM facts f JOIN lv ON lv.level = f.level GROUP BY f.item, f.attribute
)
SELECT a.item, n.attribute, n.evidence AS required, coalesce(rk.level, 'none') AS reached
FROM assessments a CROSS JOIN need n
LEFT JOIN best b ON b.item = a.item AND b.attribute = n.attribute
LEFT JOIN lv rk ON rk.r = b.r
JOIN lv rq ON rq.level = n.evidence
WHERE a.task = ?1 AND a.relevance = 'yes' AND coalesce(b.r, 0) < rq.r
