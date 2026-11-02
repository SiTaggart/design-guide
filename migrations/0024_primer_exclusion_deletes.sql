INSERT INTO queue (url, system_id, enqueued_at, error, op)
SELECT url, system_id, enqueued_at, NULL, 'delete'
FROM page_work
WHERE system_id = 'primer'
  AND (
    (item_key IS NOT NULL AND item_key != '')
    OR last_indexed IS NOT NULL
    OR url IN (
      SELECT url FROM page_copy
      WHERE system_id = 'primer'
        AND content_hash IS NOT NULL
        AND content_hash != ''
    )
  )
  AND (
    url = 'https://primer.style/view-components/lookbook'
    OR url GLOB 'https://primer.style/view-components/lookbook/*'
    OR url = 'https://primer.style/octicons/icon'
    OR url GLOB 'https://primer.style/octicons/icon/*'
    OR url GLOB 'https://primer.style/view-components/*/_*'
    OR url GLOB 'https://primer.style/view-components/_*'
  )
ON CONFLICT(url) DO UPDATE SET op = 'delete', error = NULL;

INSERT INTO queue (url, system_id, enqueued_at, error, op)
SELECT page_copy.url, page_copy.system_id, '1970-01-01T00:00:00.000Z', NULL, 'delete'
FROM page_copy
WHERE page_copy.system_id = 'primer'
  AND page_copy.content_hash IS NOT NULL
  AND page_copy.content_hash != ''
  AND (
    page_copy.url = 'https://primer.style/view-components/lookbook'
    OR page_copy.url GLOB 'https://primer.style/view-components/lookbook/*'
    OR page_copy.url = 'https://primer.style/octicons/icon'
    OR page_copy.url GLOB 'https://primer.style/octicons/icon/*'
    OR page_copy.url GLOB 'https://primer.style/view-components/*/_*'
    OR page_copy.url GLOB 'https://primer.style/view-components/_*'
  )
  AND NOT EXISTS (
    SELECT 1 FROM page_work
    WHERE page_work.system_id = page_copy.system_id AND page_work.url = page_copy.url
  )
ON CONFLICT(url) DO UPDATE SET op = 'delete', error = NULL;

DELETE FROM page_work
WHERE system_id = 'primer'
  AND (item_key IS NULL OR item_key = '')
  AND last_indexed IS NULL
  AND url NOT IN (
    SELECT url FROM page_copy
    WHERE system_id = 'primer'
      AND content_hash IS NOT NULL
      AND content_hash != ''
  )
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
    SELECT url FROM queue
    WHERE system_id = 'primer' AND op = 'delete'
  );
