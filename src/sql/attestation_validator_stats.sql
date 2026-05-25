DROP TABLE IF EXISTS attestation_validator_stats;
CREATE TABLE attestation_validator_stats (
    validator_pubkey   CHAR(64) NOT NULL,                -- 32-byte Ed25519 pubkey (hex)
    provider_id        VARCHAR(32) NOT NULL,             -- attestation provider type (e.g. 'http_get')
    fulfilled_count    BIGINT UNSIGNED NOT NULL DEFAULT 0, -- valid signatures contributed to a fulfilled response
    missed_count       BIGINT UNSIGNED NOT NULL DEFAULT 0, -- responsible-set rounds that timed out without this validator's sig
    slashed_count      BIGINT UNSIGNED NOT NULL DEFAULT 0, -- recorded slash events (Phase 4)
    quality_score      DECIMAL(8,4) NOT NULL DEFAULT 0,  -- normalized 0..1 quality metric (Phase 4)
    last_updated_block BIGINT UNSIGNED                   -- most recent block this row was touched
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX validator_pubkey_provider ON attestation_validator_stats (validator_pubkey, provider_id);
CREATE        INDEX provider_id               ON attestation_validator_stats (provider_id);
CREATE        INDEX last_updated_block        ON attestation_validator_stats (last_updated_block);
