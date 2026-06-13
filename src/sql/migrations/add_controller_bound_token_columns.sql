-- xchain:migration mode=auto
-- Migration: controller-bound tokens — add CONTROLLER + LOCK_CONTROLLER columns.
--
-- A token may bind to a deployed contract (CONTROLLER = its action_index) whose
-- exported `guard` method is consulted by the indexer before guarded native
-- actions (SEND/ORDER/SWAP/DISPENSER) on that token settle. LOCK_CONTROLLER, once
-- 1, makes the binding permanent. See protocol/Controller_Bound_Tokens.md.
--
-- Additive + idempotent (ADD ... IF NOT EXISTS): controller is NULLable (NULL =
-- uncontrolled, the pre-feature behavior for every existing row); lock_controller
-- defaults to 0. Safe to apply unattended fleet-wide. The startup drift reconciler
-- (db.js) would also add these from tokens.sql/issues.sql, but tracking them in the
-- migration ledger keeps the change explicit and auditable.

ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS controller      BIGINT UNSIGNED          AFTER lock_callback,
    ADD COLUMN IF NOT EXISTS lock_controller TINYINT(1) NOT NULL DEFAULT 0 AFTER controller;

ALTER TABLE tokens
    ADD INDEX IF NOT EXISTS controller      (controller),
    ADD INDEX IF NOT EXISTS lock_controller (lock_controller);

ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS controller      BIGINT UNSIGNED AFTER lock_callback,
    ADD COLUMN IF NOT EXISTS lock_controller VARCHAR(1)      AFTER controller;

ALTER TABLE issues
    ADD INDEX IF NOT EXISTS controller (controller);
