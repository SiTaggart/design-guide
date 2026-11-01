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
WITH stripped AS (
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
    ) AS trimmed
  FROM page_work
),
shaped AS (
  SELECT
    stripped.*,
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
  FROM stripped
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
    ) AS trimmed
  FROM queue
),
shaped AS (
  SELECT
    stripped.*,
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
  FROM stripped
),
ranked AS (
  SELECT
    shaped.*,
    ROW_NUMBER() OVER (PARTITION BY canon ORDER BY enqueued_at ASC, url ASC) AS n
  FROM shaped
)
SELECT canon, system_id, enqueued_at, error, op
FROM ranked
WHERE n = 1;

DROP TABLE queue;
ALTER TABLE queue_canonical RENAME TO queue;
CREATE INDEX IF NOT EXISTS queue_enqueued_at ON queue (enqueued_at, url);

CREATE TABLE discover_url_canonical (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

INSERT INTO discover_url_canonical (system_id, url)
WITH stripped AS (
  SELECT
    discover_url.*,
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
    ) AS trimmed
  FROM discover_url
),
shaped AS (
  SELECT
    system_id,
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
  FROM stripped
)
SELECT DISTINCT system_id, canon FROM shaped;

DROP TABLE discover_url;
ALTER TABLE discover_url_canonical RENAME TO discover_url;

CREATE TABLE discover_indexable_canonical (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

INSERT INTO discover_indexable_canonical (system_id, url)
WITH stripped AS (
  SELECT
    discover_indexable.*,
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
    ) AS trimmed
  FROM discover_indexable
),
shaped AS (
  SELECT
    system_id,
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
  FROM stripped
)
SELECT DISTINCT system_id, canon FROM shaped;

DROP TABLE discover_indexable;
ALTER TABLE discover_indexable_canonical RENAME TO discover_indexable;

CREATE TABLE discover_frontier_canonical (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

INSERT INTO discover_frontier_canonical (system_id, url)
WITH stripped AS (
  SELECT
    discover_frontier.*,
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
    ) AS trimmed
  FROM discover_frontier
),
shaped AS (
  SELECT
    system_id,
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
  FROM stripped
)
SELECT DISTINCT system_id, canon FROM shaped;

DROP TABLE discover_frontier;
ALTER TABLE discover_frontier_canonical RENAME TO discover_frontier;

DELETE FROM page_work
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url LIKE 'https://primer.style/view-components/lookbook/%'
    OR url = 'https://primer.style/octicons/icon'
    OR url LIKE 'https://primer.style/octicons/icon/%'
    OR url LIKE 'https://primer.style/view-components/%/\_%' ESCAPE '\'
    OR url LIKE 'https://primer.style/view-components/\_%' ESCAPE '\'
  );

DELETE FROM queue
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url LIKE 'https://primer.style/view-components/lookbook/%'
    OR url = 'https://primer.style/octicons/icon'
    OR url LIKE 'https://primer.style/octicons/icon/%'
    OR url LIKE 'https://primer.style/view-components/%/\_%' ESCAPE '\'
    OR url LIKE 'https://primer.style/view-components/\_%' ESCAPE '\'
  );

DELETE FROM discover_url
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url LIKE 'https://primer.style/view-components/lookbook/%'
    OR url = 'https://primer.style/octicons/icon'
    OR url LIKE 'https://primer.style/octicons/icon/%'
    OR url LIKE 'https://primer.style/view-components/%/\_%' ESCAPE '\'
    OR url LIKE 'https://primer.style/view-components/\_%' ESCAPE '\'
  );

DELETE FROM discover_indexable
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url LIKE 'https://primer.style/view-components/lookbook/%'
    OR url = 'https://primer.style/octicons/icon'
    OR url LIKE 'https://primer.style/octicons/icon/%'
    OR url LIKE 'https://primer.style/view-components/%/\_%' ESCAPE '\'
    OR url LIKE 'https://primer.style/view-components/\_%' ESCAPE '\'
  );

DELETE FROM discover_frontier
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url LIKE 'https://primer.style/view-components/lookbook/%'
    OR url = 'https://primer.style/octicons/icon'
    OR url LIKE 'https://primer.style/octicons/icon/%'
    OR url LIKE 'https://primer.style/view-components/%/\_%' ESCAPE '\'
    OR url LIKE 'https://primer.style/view-components/\_%' ESCAPE '\'
  );
