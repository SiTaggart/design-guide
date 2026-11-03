WITH doomed AS MATERIALIZED (
  SELECT url
  FROM page_work
  WHERE system_id = 'primer'
    AND status = 'done'
    AND url NOT IN (
      SELECT url
      FROM queue
      WHERE system_id = 'primer'
        AND op = 'delete'
    )
    AND (
      url = 'https://primer.style/view-components/lookbook'
      OR url GLOB 'https://primer.style/view-components/lookbook/*'
      OR url = 'https://primer.style/octicons/icon'
      OR url GLOB 'https://primer.style/octicons/icon/*'
      OR url GLOB 'https://primer.style/view-components/*/_*'
      OR url GLOB 'https://primer.style/view-components/_*'
    )
)
DELETE FROM page_work
WHERE system_id = 'primer'
  AND url IN (SELECT url FROM doomed);
