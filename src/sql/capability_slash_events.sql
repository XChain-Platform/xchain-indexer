--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

DROP TABLE IF EXISTS capability_slash_events;
CREATE TABLE capability_slash_events (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slash_action_index  BIGINT UNSIGNED NOT NULL,        -- FK to actions.action_index (the SLASH wire action)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (the equivocating validator whose bond was burned)
    capability          VARCHAR(64)  NOT NULL,           -- the consensus engine the equivocation occurred in (ENGINE_TAG family, e.g. XDEX/XCALL/XCHECKPOINT); the (pubkey,capability) dedup key
    equiv_key           VARCHAR(250) NOT NULL,           -- the shared equivocation key (ENGINE_TAG|ROUND_ID|VIEW) the two conflicting signatures proved
    amount              VARCHAR(250) NOT NULL,           -- total XCHAIN burned (active stakes + cooldown-locked unstakes)
    bounty_amount       VARCHAR(250) NOT NULL DEFAULT '0',  -- paid to the submitter (governance-configured cap; Phase D)
    treasury_amount     VARCHAR(250) NOT NULL DEFAULT '0',  -- routed to the governance treasury (remainder after bounty; Phase D)
    submitter_id        BIGINT UNSIGNED,                 -- FK to index_addresses (the SLASH submitter / bounty recipient)
    destination_id      BIGINT UNSIGNED,                 -- FK to index_addresses (treasury destination; BURN sentinel until governance sets it)
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX slash_action_index ON capability_slash_events (slash_action_index);
CREATE INDEX signing_pubkey_id  ON capability_slash_events (signing_pubkey_id);
CREATE INDEX capability_pubkey  ON capability_slash_events (signing_pubkey_id, capability);
CREATE INDEX block_index        ON capability_slash_events (block_index);
