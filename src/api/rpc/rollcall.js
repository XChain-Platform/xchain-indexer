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
 * XChain Indexer - JSON-RPC roll-call family: the DOGE presence read and the BTC verdict history.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { rollcallSignersRequest, rollcallPresence } = require('../rollcall_signers');
const { getLogger } = require('../../observability/index.js');
const { ROLLCALL_ACTIVATION } = require('../../consensus/gates/rollcall_gate.js');
const { ROLLCALL_GATES_ACTIVATION } = require('../../consensus/gates/rollcall_gates_gate.js');

function buildRollcallRpc(ctx){
    return Object.assign({}, rollcallSignersRpc(ctx), rollcallReadsRpc(ctx));
}

// ROLLCALL federation read: "which of THESE keys have a presence signature
// on chain for THIS epoch, inside THIS window?" Served off the committed
// view, DOGE side.
//
// BOUNDED BY THE CALLER'S KEY LISTS, never by enumeration. The BTC close
// asks for exactly the keys of R(E) plus the elected leader, so the answer
// size is fixed by the asker and no attacker-inflated action set can
// exhaust a page walk into `unknown` or truncate it into a false absence.
// An enumerating variant of this read would be a denial-of-service surface
// that evicts live validators, which is why it does not exist.
//
// Everything here is STRUCTURE. This indexer cannot check LEDGER_HASH
// against anything (it has no BTC view), so it returns the raw signed
// material and the BTC side re-verifies against its OWN ledger_hash and
// discards any row whose carried hash differs.
//
// `hcut` is the window cut: the highest DOGE block at or before
// `max_block_time` (the BTC header stamp at E + ACCEPT_WINDOW). The caller
// must treat a null cut, or a tip that has not buried the cut by
// ROLLCALL_DOGE_MATURITY, as `unknown` and DEFER -- never as "nobody was
// present", which would evict the whole federation on a lagging peer.
//
// `manifest_hash` is what turns a silent failure loud: a DOGE indexer
// running a decoder that predates the ROLLCALL allowlist entry drops every
// roll call at decode and would answer a perfectly well-formed "nobody
// signed". The BTC side compares this against its own vendored manifest and
// defers on a mismatch, so a stale peer stalls a block instead of evicting
// a federation.
function rollcallSignersRpc({ indexer, rollcallManifestHash }){
    return {
        async getrollcallsigners({network, epoch_height, max_block_time, pubkeys, publishers}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // DOGE only, this network, a numeric epoch and window, and key lists that
            // are hex-shaped and bounded, refused in that order (src/api/rollcall_signers.js).
            let req = rollcallSignersRequest(indexer.config,
                { network, epoch_height, max_block_time, pubkeys, publishers });
            if(req.error) return req;
            let { epoch, maxT, keys, pubs } = req;

            try {
                // Federation READ isolation: committed-only, off the block tx.
                let db = indexer.indexerDb.apiView();

                let tipIndex = await db.getLatestBlockIndex();
                let tipTime  = await db.getBlockTimeAtHeightOrNull(tipIndex);

                let hcut = await db.getRollcallWindowCut(maxT);

                // Every asked-about key's presence signature and every asked-about
                // publisher's roll call at or below the cut, null for anyone with no
                // row and for everyone while there is no cut yet.
                let { signers, publishersOut } = await rollcallPresence(db, epoch, keys, pubs, hcut);

                return {
                    hcut,
                    tip_block_index: (tipIndex === null || tipIndex === undefined) ? null : Number(tipIndex),
                    tip_block_time:  Number.isFinite(tipTime) ? tipTime : null,
                    manifest_hash:   rollcallManifestHash(),
                    rollcall_activation: ROLLCALL_ACTIVATION[indexer.config.NETWORK],
                    rollcall_gates_activation: ROLLCALL_GATES_ACTIVATION[indexer.config.NETWORK],
                    signers,
                    publishers: publishersOut
                };
            } catch (err) {
                getLogger().error('getrollcallsigners error:', err);
                return { error: 'failed to look up rollcall signers' };
            }
        },
    };
}

function rollcallReadsRpc({ indexer }){
    return {
        // Public roll-call verdict history, BTC side (validator liveness eviction
        // spec). Feeds xchain-node's `validator status` (an operator's last rolled
        // epoch + absence streak) and xchain-dashboard's consecutive-UNROLLED
        // alarm, the only detector for a federation that has silently stopped
        // rolling. Plain public read, not a federation read: absences are DERIVED
        // chain data the explorer also needs, and this table is authoritative
        // (anything the hub reports about roll calls is publisher state only).
        // Never returns responsible_set_json: that field pins K-streak membership
        // and is an internal detail this surface does not expose.
        // Body: { limit?: number }
        async getrollcalls({limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 20;
            if(max > 100) max = 100;
            // Committed-only read off an independent pooled connection
            let db = indexer.indexerDb.apiView();
            try {
                let rows = await db.getRollcalls(max);
                return { rollcalls: rows };
            } catch (err) {
                getLogger().error('getrollcalls error:', err);
                return { error: 'failed to look up roll calls' };
            }
        },

        // Roll-call absences for one staking source, BTC side. `source` is an
        // address as a caller types it; an unknown or unresolvable source is not
        // an error, it just has no absences on file.
        // Body: { source, limit?: number }
        async getrollcallabsences({source, limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 20;
            if(max > 100) max = 100;
            // Committed-only read off an independent pooled connection
            let db = indexer.indexerDb.apiView();
            try {
                let rows = await db.getRollcallAbsencesBySource(source, max);
                return { absences: rows };
            } catch (err) {
                getLogger().error('getrollcallabsences error:', err);
                return { error: 'failed to look up roll call absences' };
            }
        }
    };
}

module.exports = { buildRollcallRpc };
