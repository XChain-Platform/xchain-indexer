/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Ungated in-place mutation collectors for the state-hash preimage:
 * deactivation stamps, SLASH amount cuts, v0 request_status flips,
 * cooldown-maturity flips and backdated cooldown refund credits.
 *
 ********************************************************************/

const { copy } = require('../gate_registry');
const { tolerantQuery } = require('./tolerant_query');

const DEACTIVATION_TABLES = copy('stateHash.DEACTIVATION_TABLES');
const SLASH_SPECS = copy('stateHash.SLASH_SPECS');
const REQUEST_STATUS_TABLES = copy('stateHash.REQUEST_STATUS_TABLES');
const COOLDOWN_TABLES = copy('stateHash.COOLDOWN_TABLES');

// deactivation_block stamps. A stamp written at block B carries value
// B + delay, so a stamp landed at B iff deactivation_block = B + delay.
// Skipped when delay is unknown (mirrors collectUpdatedRows).
async function collectDeactivations(db, B, delay){
    let deactivations = {};
    for(let t of DEACTIVATION_TABLES){
        deactivations[t] = [];
        if(delay == null) continue;
        deactivations[t] = await tolerantQuery(db,
            "SELECT action_index, deactivation_block FROM `" + t + "` " +
            "WHERE deactivation_block BETWEEN ? AND ? ORDER BY action_index ASC",
            [B + delay, B + delay]);
    }
    return deactivations;
}

// SLASH amount cuts: the slashed row reached via its debit-log entry for
// this block. DISTINCT collapses multiple debits for one stake (amount is
// functionally determined by action_index).
async function collectSlashes(db, B){
    let slashes = {};
    for(let s of SLASH_SPECS){
        slashes[s.table] = await tolerantQuery(db,
            "SELECT DISTINCT t.action_index, t.amount FROM `" + s.table + "` t " +
            "JOIN `" + s.debits + "` d ON d.stake_action_index = t.action_index " +
            "WHERE d.target_table = ? AND d.block_index BETWEEN ? AND ? ORDER BY t.action_index ASC",
            [s.target, B, B]);
    }
    return slashes;
}

// v0 request_status flips (the resolved_block stamp), attests + xcalls.
async function collectRequestStatus(db, B){
    let request_status = {};
    for(let t of REQUEST_STATUS_TABLES){
        request_status[t] = await tolerantQuery(db,
            "SELECT action_index, request_status, resolved_block FROM `" + t + "` " +
            "WHERE version = 0 AND resolved_block BETWEEN ? AND ? ORDER BY action_index ASC",
            [B, B]);
    }
    return request_status;
}

// Cooldown-maturity status flips, keyed by the maturity block. status_id
// resolved to its canonical status string.
async function collectCooldown(db, B){
    let cooldown = {};
    for(let t of COOLDOWN_TABLES){
        cooldown[t] = await tolerantQuery(db,
            "SELECT t.action_index, s.status AS status FROM `" + t + "` t " +
            "LEFT JOIN index_statuses s ON (s.id = t.status_id) " +
            "WHERE t.cooldown_end_block BETWEEN ? AND ? ORDER BY t.action_index ASC",
            [B, B]);
    }
    return cooldown;
}

// Backdated cooldown refund credits: capability (GAS) + contract (own tick),
// keyed by the matured unstake's cooldown_end_block (the forward mirror of
// cooldownCredits.js). address_id/tick_id resolved; ordered with the same
// BINARY-collation-pinned keys as the ledger credit hash. A null gasTick makes
// the GAS join match nothing (capability branch empties); contract still runs.
async function collectCredits(db, B, gasTick, completedStatusId){
    if(completedStatusId == null) return [];
    return tolerantQuery(db,
        "SELECT action_index, address, tick, amount FROM ( " +
            "SELECT c.action_index, a.address AS address, ti.tick AS tick, c.amount " +
            "FROM credits c " +
            "JOIN unstakes u ON (u.action_index = c.action_index AND u.source_id = c.address_id) " +
            "JOIN index_tickers g ON (g.id = c.tick_id AND g.tick = ?) " +
            "LEFT JOIN index_addresses a ON (a.id = c.address_id) " +
            "LEFT JOIN index_tickers ti ON (ti.id = c.tick_id) " +
            "WHERE u.status_id = ? AND u.cooldown_end_block BETWEEN ? AND ? " +
            "UNION ALL " +
            "SELECT c.action_index, a.address AS address, ti.tick AS tick, c.amount " +
            "FROM credits c " +
            "JOIN contract_unstakes cu ON (cu.action_index = c.action_index AND cu.source_id = c.address_id AND cu.tick_id = c.tick_id) " +
            "LEFT JOIN index_addresses a ON (a.id = c.address_id) " +
            "LEFT JOIN index_tickers ti ON (ti.id = c.tick_id) " +
            "WHERE cu.status_id = ? AND cu.cooldown_end_block BETWEEN ? AND ? " +
        ") x ORDER BY action_index ASC, address COLLATE utf8_bin ASC, tick COLLATE utf8mb4_bin ASC, amount ASC",
        [gasTick, completedStatusId, B, B, completedStatusId, B, B]);
}

module.exports = { DEACTIVATION_TABLES, SLASH_SPECS, REQUEST_STATUS_TABLES, COOLDOWN_TABLES,
                   collectDeactivations, collectSlashes, collectRequestStatus,
                   collectCooldown, collectCredits };
