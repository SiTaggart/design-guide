CREATE TABLE queue_canonical (
  url TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  error TEXT,
  op TEXT NOT NULL DEFAULT 'fetch'
);

INSERT INTO queue_canonical (url, system_id, enqueued_at, error, op)
WITH stripped AS (
  SELECT
    queue.*,
    rtrim(
      substr(
        url,
        1,
        MIN(
          CASE WHEN instr(url, '?') = 0 THEN length(url) + 1 ELSE instr(url, '?') END,
          CASE WHEN instr(url, '#') = 0 THEN length(url) + 1 ELSE instr(url, '#') END
        ) - 1
      ),
      '/'
    ) AS bare
  FROM queue
),

deported AS (
  SELECT
    s.*,
    CASE
      WHEN instr(bare, '://') = 0 THEN bare
      ELSE
        substr(bare, 1, instr(bare, '://') + 2)
        || CASE
          WHEN lower(substr(bare, 1, instr(bare, '://') - 1)) = 'https'
            AND length(hostport) > 4 AND substr(hostport, -4) = ':443'
            THEN substr(hostport, 1, length(hostport) - 4)
          WHEN lower(substr(bare, 1, instr(bare, '://') - 1)) = 'http'
            AND length(hostport) > 3 AND substr(hostport, -3) = ':80'
            THEN substr(hostport, 1, length(hostport) - 3)
          ELSE hostport
        END
        || pathrest
    END AS trimmed
  FROM (
    SELECT
      stripped.*,
      CASE
        WHEN instr(bare, '://') = 0 THEN ''
        WHEN instr(substr(bare, instr(bare, '://') + 3), '/') = 0 THEN substr(bare, instr(bare, '://') + 3)
        ELSE substr(
          bare,
          instr(bare, '://') + 3,
          instr(substr(bare, instr(bare, '://') + 3), '/') - 1
        )
      END AS hostport,
      CASE
        WHEN instr(bare, '://') = 0 THEN ''
        WHEN instr(substr(bare, instr(bare, '://') + 3), '/') = 0 THEN ''
        ELSE substr(
          bare,
          instr(bare, '://') + 2 + instr(substr(bare, instr(bare, '://') + 3), '/')
        )
      END AS pathrest
    FROM stripped
  ) AS s
),
shaped AS (
  SELECT
    deported.*,
    CASE
      WHEN instr(trimmed, '://') = 0 THEN trimmed
      WHEN instr(substr(trimmed, instr(trimmed, '://') + 3), '/') = 0 THEN lower(trimmed) || '/'
      ELSE
        substr(trimmed, 1, instr(trimmed, '://') + 2)
        || lower(
          substr(
            trimmed,
            instr(trimmed, '://') + 3,
            instr(substr(trimmed, instr(trimmed, '://') + 3), '/') - 1
          )
        )
        || substr(
          trimmed,
          instr(trimmed, '://') + 2 + instr(substr(trimmed, instr(trimmed, '://') + 3), '/')
        )
    END AS canon
  FROM deported
),
ranked AS (
  SELECT
    shaped.*,
    ROW_NUMBER() OVER (
      PARTITION BY canon
      ORDER BY CASE WHEN op = 'seen' THEN 1 ELSE 0 END, enqueued_at ASC, url ASC
    ) AS n
  FROM shaped
)
SELECT canon, system_id, enqueued_at, error, op
FROM ranked
WHERE n = 1;

DROP TABLE queue;
ALTER TABLE queue_canonical RENAME TO queue;
CREATE INDEX IF NOT EXISTS queue_enqueued_at ON queue (enqueued_at, url);
