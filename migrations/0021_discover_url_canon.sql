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
