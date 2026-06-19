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
 * XChain Platform Action - CROSS_SETTLE (system-injected, mirror-driven)
 *
 * Settles THIS chain's leg of a cross-chain DEX match. The xchain-hub federation
 * matched two cross-chain offers, signed the match (2f+1 `cross_chain` validators),
 * and delivered it through the hub-DB mirror (cross_chain_matches). This handler
 * is injected once per effective, unsettled match for this chain (see
 * utility.js processCrossChainSettlements), verifies the signatures locally, and
 * releases the local offer's escrow to the counterparty's payout address.
 *
 * There is NO on-chain transaction for the settlement; it is an internal action
 * (like SWAP_MATCH), recorded in cross_chain_settlements for idempotency + rollback.
 *
 * Trust: the match terms are only acted on after 2f+1 `cross_chain` signatures
 * verify against the mirrored capability snapshot at the match's snapshot_block;
 * a bad mirror can delay but cannot forge a settlement.
 *
 * Spec: xchain-documentation/protocol/Cross_Chain_DEX.md
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');

class Cross_Settle {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Canonical signing string. MUST byte-match the hub's CrossChainDexEngine._canonicalMatch.
    // Phase B appends the fill fields after `network` (Phase-A field order preserved):
    // a_amount/b_amount are the FILL settled by THIS match; *_kind + *_filled_before bind
    // sequential partial fills apart.
    _canonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // EQUIV (WI-2 bump 2): VIEW = the row's persisted finalizing_view (the view the
        // hub round finalized at; == pending.view when the quorum sigs were taken). TAG=XDEX,
        // ROUND_ID=match_id. Gate on the row's snapshot_block + network. Must byte-match the hub.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    }

    async parse(params, data, error){
        let m = data['MATCH'];
        if(!m) return;

        let coin = this.config['COIN'];

        // ── Network scope ─────────────────────────────────────────────────────
        // A match is bound to the network it was matched + signed on (also in the
        // canonical below). Refuse any match not for THIS indexer's network so a
        // regtest/testnet-signed match can never settle on a mainnet indexer even if
        // its row is mirrored in. getEffectiveUnsettledMatches already filters on
        // network; this is the security boundary's belt-and-suspenders guard.
        if(String(m.network || '') !== String(this.config['NETWORK'] || '')){
            console.warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : network mismatch (' + m.network + ' != ' + this.config['NETWORK'] + ') : skipping');
            return;
        }

        // ── Verify the cross_chain quorum signatures over the canonical match ──
        // At/above STAKE_WEIGHTED_QUORUM (keyed on the BTC snapshot_block + network)
        // the bar is summed signer STAKE > 2/3 of S, deduped by staking source;
        // below it, the legacy 2f+1 signer COUNT. Both verify against the SAME locked
        // snapshot the hub used, so hub and indexer agree without trust.
        let snapshotBlock = Number(m.snapshot_block);
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, m.network);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
            : await this.indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
        let N = (validators && validators.length) ? validators.length : 0;
        if(N === 0){
            // The capability snapshot for this block isn't mirrored yet. In distributed mode
            // the block loop's snapshot-sync barrier (HubDbSync.waitForSnapshotSync) front-stops
            // this by deferring the whole block until the snapshot is present, so every operator
            // settles the match at the same height; this early-return is a defensive guard for
            // the residual race / single-host path. The match stays unsettled + effective and
            // retries on a later block. NOT an error. (Deterministic quorum-N under PARTIAL
            // snapshot arrival is sealed separately by the multi-node design; presence here.)
            console.log("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : capability snapshot not synced : deferring');
            return;
        }

        let sigs;
        try { sigs = JSON.parse(m.validator_signatures || '[]'); }
        catch(_) { sigs = []; }

        let canonical = this._canonical(m);
        // Collect the distinct pubkeys that produced a valid signature AND are in the
        // locked snapshot (presence in the snapshot = qualified, same membership the
        // hub tallied). Used by both the weighted predicate and the count check.
        let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk  = String(s.pubkey || '').toLowerCase();
            let sig = String(s.sig || '').toLowerCase();
            if(seen.has(pk)) continue;
            seen.add(pk);
            if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(!snapPubkeys.has(pk)) continue;
            if(!ed25519.verify(canonical, sig, pk)) continue;
            validSigners.push(pk);
        }
        let quorumMet = weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        if(!quorumMet){
            // Genuinely insufficient quorum (the snapshot IS present). Do not
            // record a settlement; a malformed/forged match never settles.
            console.warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')') + ' : skipping');
            return;
        }

        // ── Identify this chain's leg ────────────────────────────────────────
        // a = canonical-lower. On a's chain release a's escrow to b's payout (b_payout_addr);
        // on b's chain release b's escrow to a's payout (a_payout_addr).
        let isA = (m.a_chain === coin);
        if(!isA && m.b_chain !== coin) return;                  // not our match

        let localActionIndex = isA ? Number(m.a_action_index) : Number(m.b_action_index);
        let localKind        = String(isA ? m.a_kind : m.b_kind) || 'swap';
        let giveTick         = isA ? m.a_tick : m.b_tick;
        let giveAmount       = isA ? m.a_amount : m.b_amount;   // FILL released from local escrow
        let getAmount        = isA ? m.b_amount : m.a_amount;   // FILL the local offer receives
        let getTick          = isA ? m.b_tick : m.a_tick;       // tick the local offer receives
        let giveOwnership    = Number(isA ? m.a_ownership : m.b_ownership);
        let payoutAddr       = isA ? m.b_payout_addr : m.a_payout_addr;
        let counterpartyCoin = isA ? m.b_chain : m.a_chain;

        // ORDER leg → partial-fill settlement (release the fill, decrement remaining, complete
        // only when fully filled). SWAP leg falls through to the Phase-A full-release path.
        if(localKind === 'order')
            return await this._settleOrderLeg(data, m, coin, localActionIndex, giveTick, giveAmount, getAmount, getTick, giveOwnership, payoutAddr, counterpartyCoin);

        // The local offer must still be open (not already settled / cancelled / expired).
        // A cross-chain swap stores get_coin = counterparty coin, so getSwapInfo resolves it.
        let swapInfo = await this.indexerDb.getSwapInfo(counterpartyCoin, localActionIndex);
        if(!swapInfo){
            console.warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : local offer ' + coin + ':' + localActionIndex + ' not found : skipping');
            return;
        }
        if(swapInfo['SWAP_STATUS'] !== 'open'){
            // Already terminal (settled via a prior pass, cancelled, or expired). Record the
            // settlement so we stop re-evaluating it, but move no funds. The record is
            // anchored to a real internal action row so a reorg (which may revive the
            // offer's open status) drops it and the match re-applies.
            console.log("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : offer ' + coin + ':' + localActionIndex + ' not open (' + swapInfo['SWAP_STATUS'] + ') : recording no-op settlement');
            await this._recordNoopSettlement(data, m, localActionIndex);
            return;
        }

        // ── Settle: mint an internal action and release escrow → counterparty ──
        let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
        data['STATUS'] = 'valid';

        console.log("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : release ' +
                    giveAmount + ' ' + coin + ':' + (giveTick || coin) + ' → ' + payoutAddr + ' : ' + data['STATUS']);

        let credits = [], debits = [], escrows = [];
        if(giveOwnership === 1){
            await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, giveTick, swapInfo['SOURCE'], payoutAddr);
        } else {
            escrows.push([giveTick, -giveAmount, payoutAddr]);
            credits.push([giveTick,  giveAmount, payoutAddr]);
            this.util.addAddressTicker(payoutAddr, giveTick);
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Complete the offer and record the settlement (idempotent on match_id).
        await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], localActionIndex, 'complete');
        await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, localActionIndex, data['BLOCK_INDEX']);

        let addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);

        await this.mapper.createMappings(data);
    }

    // Record a no-op settlement for a match whose local offer is already terminal:
    // mint the internal CROSS_SETTLE action (the rollback anchor) and the
    // cross_chain_settlements row, move no funds. Without the record, the match
    // stays "effective + unsettled" and re-evaluates on every subsequent block.
    async _recordNoopSettlement(data, m, localActionIndex){
        let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
        data['STATUS'] = 'valid';
        await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, localActionIndex, data['BLOCK_INDEX']);
        await this.mapper.createMappings(data);
    }

    // Settle one ORDER leg of a cross-chain match: release only THIS match's fill from escrow
    // to the counterparty, record the fill (so the order's remaining drops), and complete the
    // order only once fully filled. Multiple partial fills each settle once (distinct match_id
    // → distinct cross_chain_settlements row), accumulating against the same local order.
    async _settleOrderLeg(data, m, coin, localActionIndex, giveTick, giveAmount, getAmount, getTick, giveOwnership, payoutAddr, counterpartyCoin){
        // A cross-chain order stores get_coin = counterparty coin, so getOrderInfo (which
        // filters by get_coin) resolves it under the counterparty coin.
        let orderInfo = await this.indexerDb.getOrderInfo(counterpartyCoin, localActionIndex);
        if(!orderInfo){
            console.warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : local order ' + coin + ':' + localActionIndex + ' not found : skipping');
            return;
        }
        if(orderInfo['ORDER_STATUS'] !== 'open'){
            // Terminal already (fully filled by a prior pass, cancelled, or expired). Record
            // the settlement so we stop re-evaluating it but move no funds (same
            // reorg-anchored no-op record as the swap leg above).
            console.log("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : order ' + coin + ':' + localActionIndex + ' not open (' + orderInfo['ORDER_STATUS'] + ') : recording no-op settlement');
            await this._recordNoopSettlement(data, m, localActionIndex);
            return;
        }

        let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
        data['STATUS'] = 'valid';

        console.log("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : order fill release ' +
                    giveAmount + ' ' + coin + ':' + (giveTick || coin) + ' → ' + payoutAddr + ' : ' + data['STATUS']);

        let credits = [], debits = [], escrows = [];
        if(giveOwnership === 1){
            // Ownership orders are single-fill: transfer ownership, no balance escrow.
            await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, giveTick, orderInfo['SOURCE'], payoutAddr);
        } else {
            escrows.push([giveTick, -giveAmount, payoutAddr]);
            credits.push([giveTick,  giveAmount, payoutAddr]);
            this.util.addAddressTicker(payoutAddr, giveTick);
        }
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Record the fill so getOrderAmountsRemaining deducts it (single source of truth).
        await this.indexerDb.recordCrossChainOrderFill(data['ACTION_INDEX'], localActionIndex, giveAmount, getAmount, coin, giveTick, counterpartyCoin, getTick);

        // Complete the order only when nothing remains to give (or it was an ownership order,
        // which is single-fill). Otherwise it stays 'open' for further fills.
        let [give_remaining] = await this.indexerDb.getOrderAmountsRemaining(localActionIndex);
        if(giveOwnership === 1 || this.util.bclte(give_remaining, 0))
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], localActionIndex, 'complete');

        // Record the settlement (idempotent on match_id).
        await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, localActionIndex, data['BLOCK_INDEX']);

        let addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);

        await this.mapper.createMappings(data);
    }
}

module.exports = Cross_Settle;
