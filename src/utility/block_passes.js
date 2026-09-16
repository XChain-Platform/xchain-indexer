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
 * XChain Indexer - Utility: per-block sweeps
 *
 * The per-block synthetic-action sweeps: ATTEST expiries, contract delegation
 * materialization, order/swap/dispenser expirations, BET passes, cross-chain settlements
 * and dispenser cancellations.
 *
 ********************************************************************/

'use strict';

// The per-block cross-chain settlement cap processCrossChainSettlements applies once its flag
// day is on. Read at the top of the file from the leaf protocol constants module, which
// requires nothing, so the pass resolves the same number without a require inside its body.
const { CROSS_SETTLE_MAX_PER_BLOCK } = require('../protocol/constants.js');

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Process any ATTEST v0 requests whose DEADLINE_BLOCK has passed without a
    // fulfilled response. Synthesizes one ATTEST v2 action per stale row; the
    // handler flips the request status to 'expired' and fires the callback with
    // status='expired'.
    //
    // Driven by block_index (not block_time) because attestation deadlines are
    // measured in blocks, matching the wire format DEADLINE_BLOCKS.
    async processAttestationExpirations(actions, db, block_index, block_time){
        // Capped per block (ATTEST_MAX_EXPIRIES_PER_BLOCK). Overflow needs
        // no bookkeeping here: the rows this block did not take are still 'pending'
        // with deadline_block < block_index, so the next block's sweep selects them,
        // in the same total order, until the backlog drains.
        let expired = await db.getExpiredAttestationRequests(block_index);
        for(let info of expired){
            let data = {};
            data['ACTION']       = 'ATTEST';
            data['FORMAT']       = 2;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['REQUEST_ID']   = info.request_id;
            data['IS_SYNTHETIC'] = true;
            // Mirror the synthetic-action positional layout: VERSION|REQUEST_ID
            await actions.processAction('ATTEST', [2, info.request_id], data, null);
        }
    },

    // Materialize matured DELEGATE v1 signing-key rotations onto contract_stakes.
    //
    // Runs at the TOP of a block, before its transactions, so a rotation is in force for
    // everything that block does (EXECUTE snapshots, UNSTAKE lookups, SLASH deductions) exactly
    // at its activation_block, the same `activation_block <= blockIndex` boundary every other
    // contract-stake read uses. Placing it with the end-of-block sweeps instead would delay each
    // rotation by one block, which is a consensus difference, not a cosmetic one.
    //
    // Gated by CONTRACT_DELEGATION_MATERIALIZE: below the flag-day this is a no-op and history
    // replays byte-identically, because before it a rotation existed only in
    // contract_delegations and nothing that reads stake ownership ever looked there. The gate is
    // evaluated once per block here (never inside db.materializeContractDelegations), so there
    // is exactly one place a node can decide the rotation is live.
    async processContractDelegationMaterializations(actions, db, block_index){
        if(!(await actions.protocolChanges.isEnabled('CONTRACT_DELEGATION_MATERIALIZE', block_index)))
            return [];
        return await db.materializeContractDelegations(block_index);
    },

    // Process any orders, swaps, or dispensers which are past expiration
    // NOTE: We currently use block_time to expire items... not ideal as block times can be manipulated
    // TODO: Revisit this code and handle calculating block time more elegantly
    async processExpirations(actions, db, block_index, block_time){
        let expired = await db.getExpiredItems(block_time);
        for(let info of expired){
            // Define basic ACTION transaction data object
            let action = String(info.type + '_EXPIRE').toUpperCase();
            let data = {};
            data['ACTION']       = action;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['ACTION_INDEX'] = info.action_index;
            await actions.processAction(action, null, data, null);
        }
        // Process expired COINPay obligations
        let expiredObligations = await db.getExpiredCoinpayObligations(block_time);
        for(let info of expiredObligations){
            let action = 'COINPAY_EXPIRE';
            let data = {};
            data['ACTION']       = action;
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['ACTION_INDEX'] = info.action_index;
            await actions.processAction(action, null, data, null);
        }
    },

    // BET end-of-block pass: latch feeds closed at DEADLINE, expire feeds at
    // expire_at. Runs
    // AFTER all user txs in the block (call site next to processExpirations),
    // inside the block's atomic write. A deliberate BOUNDED sibling of
    // processExpirations, NOT an extension of it: that pass scans its whole due
    // set with no cap, which is tolerable there only because
    // orders/dispensers cost real fees to open. Feed creation inside the free
    // window is cheap, so both steps here cap their per-block work; deferral is
    // safe because both predicates are monotone in time and the user-facing
    // checks (place, resolve) read the clock directly rather than trusting the
    // latch alone. Deterministic: due sets are ordered (deadline|expire_at ASC,
    // action_index ASC tiebreak), so every node processes and defers the same
    // feeds.
    async processBetPasses(actions, db, block_index, block_time){
        // Step 1 - latch: every open feed whose DEADLINE has passed becomes
        // `closed`, one-way, at most MAX_BET_PASS_ROWS feeds per block. The stored
        // latch (not a derived predicate) is what stops a miner mining a backdated
        // block after the deadline crossed and injecting an informed bet. The
        // write is idempotence-guarded in SQL (only where closed_block IS NULL and
        // the status still reads open), so a crash-restart replay of this block
        // cannot latch twice.
        let dueLatch = await db.getBetFeedsDueLatch(block_time, this.config['MAX_BET_PASS_ROWS']);
        for(let feed of dueLatch)
            await db.latchBetFeedClosed(feed.action_index, block_index);

        // Step 2 - expire: feeds past expire_at with no resolve get a system
        // BET_EXPIRE (refund all, no fee). WHOLE feeds in expire_at ASC order,
        // doubly bounded: by feed count (MAX_BET_PASS_ROWS, or a flood of
        // zero-bet feeds - which consume no credits - would make the credit
        // budget alone unbounded) and by refund credits (MAX_BET_PASS_CREDITS,
        // or one block could emit ROWS x MAX_BETS_PER_FEED credits). The loop
        // STOPS at the first feed that does not fit the remaining credit budget
        // (never skips past it): the processed set is always an exact prefix of
        // the ordered due list, identical on every node. MAX_BET_PASS_CREDITS >=
        // MAX_BETS_PER_FEED guarantees any single feed fits a full budget, so a
        // deferred max-size feed expires first thing next block rather than
        // wedging. A feed can latch (step 1) and expire (here) in the same pass
        // on a large block-time jump over a small refund window.
        let dueExpiry     = await db.getBetFeedsDueExpiry(block_time, this.config['MAX_BET_PASS_ROWS']);
        let creditBudget  = this.config['MAX_BET_PASS_CREDITS'];
        for(let feed of dueExpiry){
            let refunds = Number(feed.open_bets) || 0;
            if(refunds > creditBudget)
                break;
            creditBudget -= refunds;
            let data = {};
            data['ACTION']       = 'BET_EXPIRE';
            data['BLOCK_INDEX']  = block_index;
            data['BLOCK_TIME']   = block_time;
            data['ACTION_INDEX'] = feed.action_index;
            await actions.processAction('BET_EXPIRE', null, data, null);
        }
    },

    // Settle this chain's leg of any cross-chain DEX matches that are effective at or
    // before this block. Each match is a finalized, validator-signed record delivered via
    // the hub mirror; CROSS_SETTLE verifies the 2f+1 signatures and releases escrow to the
    // counterparty. Idempotent: getEffectiveUnsettledMatches excludes matches already in
    // cross_chain_settlements. The caller gates this on the match-sync barrier so every
    // operator of this chain settles the same matches at the same block.
    //
    // Capped at CROSS_SETTLE_MAX_PER_BLOCK, the same discipline the XCALL passes below
    // already carry: each settlement runs a 2f+1 signature verification and an escrow
    // release, so an uncapped mirror backlog would blow BLOCK_PROCESS_TIMEOUT and wedge
    // every operator of the chain at the identical block. Overflow carries
    // forward in (snapshot_block, match_id) order; nothing is dropped.
    //
    // The cap is FLAG-DAY GATED on CROSS_SETTLE_PER_BLOCK_CAP (operator ruling of
    // 2026-08-11), because deferring a settlement to a later block moves
    // actions rows, the contract hash and the checkpoint preimage: applying it to blocks
    // the live mainnet chains already settled would fork a from-genesis replay against
    // them. Pre-flag-day the pass drains the full effective backlog exactly as before,
    // so this is a byte-for-byte no-op on every already-indexed block. The gate must be
    // consulted per block (not cached) so the switch happens at the same block on every
    // operator; testnet/regtest are genesis-active, so both suites and drills run capped.
    async processCrossChainSettlements(actions, db, block_index, block_time){
        let coin    = db.config['COIN'];
        let capped  = await actions.protocolChanges.isEnabled('CROSS_SETTLE_PER_BLOCK_CAP', block_index);
        // MAX_SAFE_INTEGER rather than 0/undefined for the pre-flag-day limit: the
        // db-side default treats a falsy limit as "caller forgot" and re-applies the
        // protocol cap, which would silently gate-bypass in the ON direction.
        let cap     = capped ? CROSS_SETTLE_MAX_PER_BLOCK
                             : Number.MAX_SAFE_INTEGER;
        // block_index is the admission-era binding key (db.mirrorBindClause); below the
        // activation the read ignores it and binds on block_time exactly as before.
        let matches = await db.getEffectiveUnsettledMatches(coin, block_time, cap, block_index);
        for(let m of matches){
            let data = {};
            data['ACTION']      = 'CROSS_SETTLE';
            data['BLOCK_INDEX'] = block_index;
            data['BLOCK_TIME']  = block_time;
            data['MATCH']       = m;
            await actions.processAction('CROSS_SETTLE', null, data, null);
        }
    },

    // Process any dispensers which have been cancelled and need to be closed
    // NOTE: We currently use block_time to expire items... not ideal as block times can be manipulated
    // TODO: Revisit this code and handle calculating block time more elegantly
    async processCancellations(actions, db, block_index, block_time){
        let cancels = await db.findCancelledDispensers(block_time);
        for(let action_index of cancels){
            // Define basic ACTION transaction data object
            let action = 'DISPENSER_CLOSE';
            let data = {};
            data['ACTION']                 = action;
            data['BLOCK_INDEX']            = block_index;
            data['BLOCK_TIME']             = block_time;
            data['DISPENSER_ACTION_INDEX'] = action_index;
            data['DISPENSER_STATUS']       = 'cancelled';
            await actions.processAction(action, null, data, null);
        }
    }
};
