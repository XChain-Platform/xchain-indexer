-- xchain:migration mode=auto

ALTER TABLE pending_hub_pushes
  ADD COLUMN IF NOT EXISTS delivered_to JSON NULL AFTER payload;
