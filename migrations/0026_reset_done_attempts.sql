UPDATE page_work
SET attempts = 0,
    status = CASE
      WHEN status = 'failed' AND attempts > 5 THEN 'pending'
      ELSE status
    END,
    error = CASE
      WHEN status = 'failed' AND attempts > 5 THEN NULL
      ELSE error
    END,
    claimed_at = CASE
      WHEN status = 'failed' AND attempts > 5 THEN NULL
      ELSE claimed_at
    END,
    claim_token = CASE
      WHEN status = 'failed' AND attempts > 5 THEN NULL
      ELSE claim_token
    END
WHERE (status = 'done' AND attempts != 0)
   OR (status = 'failed' AND attempts > 5);
