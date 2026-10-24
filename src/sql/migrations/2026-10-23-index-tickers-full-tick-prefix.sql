-- xchain:migration mode=auto
-- Widen the binary unique key to the maximum accepted TICK length. Existing rows are
-- already unique over their first 200 characters, so this weaker key cannot expose a
-- duplicate during the rebuild. The action and database paths retain the 200-character
-- collision behavior below TICK_NORMALIZE_ACTIVATION.

ALTER TABLE index_tickers
  DROP INDEX IF EXISTS tick,
  ADD UNIQUE INDEX tick (tick(250));
