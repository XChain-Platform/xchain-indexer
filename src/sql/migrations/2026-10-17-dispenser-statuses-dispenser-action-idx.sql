-- xchain:migration mode=auto

CREATE INDEX IF NOT EXISTS dispenser_action_action ON dispenser_statuses (dispenser_action_index, action_index);
