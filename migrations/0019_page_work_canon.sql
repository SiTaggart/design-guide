CREATE TABLE page_work_canonical (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_crawled TEXT,
  last_indexed TEXT,
  claimed_at TEXT,
  error TEXT,
  item_key TEXT,
  claim_token TEXT,
  PRIMARY KEY (system_id, url)
);

INSERT INTO page_work_canonical (
  system_id, url, kind, status, enqueued_at, attempts,
  last_crawled, last_indexed, claimed_at, error, item_key, claim_token
)
WITH stripped AS MATERIALIZED (
  SELECT
    page_work.*,
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
  FROM page_work
),

deported AS MATERIALIZED (
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
shaped AS MATERIALIZED (
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
      PARTITION BY system_id, canon
      ORDER BY
        CASE status WHEN 'done' THEN 0 ELSE 1 END,
        CASE WHEN last_indexed IS NOT NULL THEN 0 ELSE 1 END,
        enqueued_at ASC,
        url ASC
    ) AS n,
    MIN(enqueued_at) OVER (PARTITION BY system_id, canon) AS first_enqueued,
    MAX(last_crawled) OVER (PARTITION BY system_id, canon) AS crawled,
    MAX(last_indexed) OVER (PARTITION BY system_id, canon) AS indexed,
    MAX(CASE kind WHEN 'seed' THEN 1 ELSE 0 END) OVER (PARTITION BY system_id, canon) AS any_seed
  FROM shaped
)
SELECT
  system_id,
  canon,
  CASE WHEN any_seed = 1 THEN 'seed' ELSE kind END,
  status,
  first_enqueued,
  attempts,
  crawled,
  indexed,
  CASE WHEN status = 'done' THEN NULL ELSE claimed_at END,
  error,
  item_key,
  CASE WHEN status = 'done' THEN NULL ELSE claim_token END
FROM ranked
WHERE n = 1;

DROP TABLE page_work;
ALTER TABLE page_work_canonical RENAME TO page_work;
