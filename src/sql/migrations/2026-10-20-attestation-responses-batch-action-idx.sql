-- xchain:migration mode=auto

CREATE INDEX IF NOT EXISTS idx_batch_action ON attestation_responses (network, batch_action_index);
