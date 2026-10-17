-- xchain:migration mode=auto

ALTER TABLE credits
  ADD INDEX IF NOT EXISTS credits_address_tick_amount (address_id, tick_id, amount);

ALTER TABLE debits
  ADD INDEX IF NOT EXISTS debits_address_tick_amount (address_id, tick_id, amount);
