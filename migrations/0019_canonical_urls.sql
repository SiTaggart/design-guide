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
    ) AS bare
  FROM page_work
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
    ) AS bare
  FROM discover_url
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
  FROM deported
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
    ) AS bare
  FROM discover_indexable
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
  FROM deported
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
    ) AS bare
  FROM discover_frontier
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
  FROM deported
)
SELECT DISTINCT system_id, canon FROM shaped;

DROP TABLE discover_frontier;
ALTER TABLE discover_frontier_canonical RENAME TO discover_frontier;

INSERT INTO queue (url, system_id, enqueued_at, error, op)
SELECT url, system_id, enqueued_at, NULL, 'delete'
FROM page_work
WHERE system_id = 'primer'
  AND last_indexed IS NOT NULL
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  )
ON CONFLICT(url) DO UPDATE SET op = 'delete', error = NULL;

DELETE FROM page_work
WHERE system_id = 'primer'
  AND last_indexed IS NULL
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  );

DELETE FROM queue
WHERE system_id = 'primer'
  AND op != 'delete'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  );

DELETE FROM discover_url
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  );

DELETE FROM discover_indexable
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  );

DELETE FROM discover_frontier
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  );

DELETE FROM page_copy
WHERE system_id = 'primer'
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  )
  AND url NOT IN (
    SELECT url FROM page_work
    WHERE system_id = 'primer' AND last_indexed IS NOT NULL AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  )
  );
