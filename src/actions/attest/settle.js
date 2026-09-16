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
 * XChain Indexer - ATTEST handler part
 *
 * Fee settlement at the terminal flip: the split, who it pays, and the broadcast-fee carve-out.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const attestBcastFee  = require('./attest_broadcast_fee_gate.js');
const wid     = require('../../attest_responsible_widening_activation.js');
// The zero-conf flip, keyed on the REQUEST's own block. Read here for the fulfilled
// fee split, which pays the verified signers rather than the widened set above it.
const zc      = require('../../attest_zero_conf_activation.js');
const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');

module.exports = {
    // Settle the request fee escrowed at v0 (paid attestations). Runs at the
    // terminal flip and writes ledger rows at the SETTLING action's action_index
    // (the v1 response or the synthesized v2 expire), so a reorg of the settle
    // action removes them generically while the v0 escrow row survives.
    //   'fulfilled'          → escrow → REWARD pool + equal validator_rewards
    //                          split across the responsible set (floor to GAS
    //                          decimals; remainder dust stays in the pool;
    //                          COLLECT only ever pays what validator_rewards
    //                          reference, so the pool stays solvent). At/above
    //                          ATTEST_BROADCAST_FEE the leader
    //                          broadcast-fee reimbursement is carved out FIRST
    //                          and the split runs on what is left; the pool
    //                          credit stays the FULL escrow either way, so the
    //                          solvency argument is unchanged (carve-out +
    //                          N*share <= escrow by construction, both floored
    //                          onto the same decimal grid). At/above
    //                          ATTEST_ZERO_CONF the split pays the verified
    //                          SIGNERS of the response instead of the whole
    //                          widened set (signerPaySet); the pool credit,
    //                          the carve-out and the solvency argument are
    //                          unchanged, since the paid set is a subset.
    //   'errored'/'expired'  → escrow → refund to FEE_PAYER.
    // Feeless requests (fee_amount NULL/0) are a no-op.
    async settleRequestFee(request, data, terminalStatus){
        let feeAmount = String((request && request.fee_amount) || '0');
        if(!this.util.bcgt(feeAmount, '0')) return;

        let gas      = this.config['GAS'];
        let feePayer = String(request.fee_payer || '');
        if(!feePayer){
            getLogger().warn('Attestation fee settle: missing fee_payer for request ' + String(request.request_id).substring(0,16) + '..., fee left in escrow');
            return;
        }

        // Release the escrow held against FEE_PAYER (negative escrow row, the
        // order_expire idiom) and route the funds per the terminal status.
        let escrows = [[gas, this.util.bcmul(feeAmount, '-1', 8), feePayer]];
        let credits = [];
        this.util.addAddressTicker(feePayer, gas);

        if(terminalStatus === 'fulfilled'){
            await this.splitFulfilledFee(request, data, feeAmount, gas, credits);
        } else {
            // errored / expired: service not rendered, refund the payer
            credits.push([gas, feeAmount, feePayer]);
            getLogger().info("\t ATTEST fee : " + feeAmount + ' ' + gas + ' refunded to FEE_PAYER (' + terminalStatus + ')' +
                        ' [request ' + String(request.request_id).substring(0,16) + '...]');
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, [], escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    },

    // The fulfilled disposition: the pool credit, who the escrow is split among, and the
    // split itself. Mutates `credits`, which the caller hands to the ledger write.
    async splitFulfilledFee(request, data, feeAmount, gas, credits){
        let rewardPool = this.config['ADDRESS']['REWARD'];
        this.util.addAddressTicker(rewardPool, gas);
        credits.push([gas, feeAmount, rewardPool]);

        // Same widened set the v1 verify filter admitted signatures from, and for the
        // same reason: a validator the ladder let sign must be in the split it earned a
        // share of. `data` is the v1 action, so its BLOCK_INDEX is the response height.
        let responsible = await this.computeResponsibleSet(
            String(request.request_id), request.redundancy, Number(request.block_index), request.provider_id,
            wid.widenSlots(data['BLOCK_INDEX'], Number(request.block_index),
                           request.deadline_block, this.config['NETWORK'])
        );
        // WHO IS PAID. Below the zero-conf height the split is the recomputed
        // responsible set, unchanged. At and above it the escrow is split among the
        // validators whose signatures the accepted response actually carries
        // by design, because the slot-widening ladder seats a headroom member on EVERY
        // request, and a member that need never sign would otherwise take a share
        // off each validator that did. `responsible` is still the set the broadcast-fee
        // carve-out is measured against and is still the ASSIGNED set the expiry
        // charge faults, so neither the assignment plane nor missed_count
        // moves with this.
        let paid = responsible;
        if(zc.isZeroConfActive(Number(request.block_index), this.config['NETWORK']))
            paid = this.signerPaySet(request, data, responsible);

        let broadcastFee = '0';
        if(responsible.length > 0)
            broadcastFee = await this.payFeeSplit(request, data, responsible, paid, feeAmount, gas);
        getLogger().info("\t ATTEST fee : " + feeAmount + ' ' + gas + ' → REWARD pool, split ' +
                    paid.length + ' way(s)' +
                    (this.util.bcgt(broadcastFee, '0') ? ', broadcast reimbursement ' + broadcastFee : '') +
                    ' [request ' + String(request.request_id).substring(0,16) + '...]');
    },

    // The reward rows a fulfilled settle writes: the leader's broadcast-fee carve-out
    // first, then the equal share to every paid validator. Returns the carve-out, which
    // is what the caller reports.
    async payFeeSplit(request, data, responsible, paid, feeAmount, gas){
        let broadcastFee = '0';
        // Equal split, floored to GAS decimals (feeCap = min(8, gasDecimals)),
        // matching the precision cap applied at parse time (line 146). Deterministic
        // across validators (bcmulfloor exists for exactly this concern).
        let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
            await this.indexerDb.getTickerId(gas)
        );
        let feeCap = Math.min(8, gasDecimals);

        // Leader broadcast-fee reimbursement, flag-day gated. Carved out of the
        // escrow BEFORE the split, because it reimburses a cost the broadcaster
        // already paid a miner rather than rewarding the work the split pays for.
        // Below the gate it is '0' and the split sees the whole fee, byte-identically
        // to the pre-flag-day ledger. See attest_broadcast_fee_gate.js.
        broadcastFee = await this.broadcastFeeReimbursement(request, data, responsible, feeAmount, feeCap);
        // Below the gate (and on any request that reimburses nothing) the escrow is
        // handed to the split UNTOUCHED rather than round-tripped through bcsub: a
        // parse-valid FEE_AMOUNT already sits on the feeCap grid, but bcsub renders at
        // fixed precision and therefore ROUNDS, so keeping the legacy path arithmetic-
        // free is what makes "byte-identical below the flag-day" true by construction
        // instead of by argument. Above the gate both operands are on that same grid,
        // so the subtraction is exact and the pool stays solvent.
        let splitPool = feeAmount;

        if(this.util.bcgt(broadcastFee, '0')){
            splitPool = this.util.bcsub(feeAmount, broadcastFee, feeCap);
            // The broadcaster is a responsible-set member, so it collects this row
            // ON TOP of its equal share below ("additionally receives").
            // A distinct reward_type keeps the two rows apart under the
            // (source, pubkey, type, round_reference) unique key.
            await this.indexerDb.createValidatorReward(
                responsible[0], Number(request.action_index), 'attest_bcast', broadcastFee, data['BLOCK_INDEX'], true
            );
        }

        let perValidator = this.util.bcmulfloor(
            this.util.bcdiv(splitPool, String(paid.length), 18), '1', feeCap
        );
        if(this.util.bcgt(perValidator, '0')){
            for(let pk of paid){
                // round_reference is BIGINT; key idempotency on the
                // REQUEST's action_index (unique per request), not the
                // 64-hex request_id.
                await this.indexerDb.createValidatorReward(
                    pk, Number(request.action_index), 'attest_fee', perValidator, data['BLOCK_INDEX'], true
                );
            }
        }

        return broadcastFee;
    },

    // The pubkeys the fulfilled split pays at and above the zero-conf height: the
    // verified signers inlined on the settling response row, deduped, lower-cased and
    // sorted ascending. The order is the WRITE order of the validator_rewards
    // rows, so it is sorted rather than left in the hub-authored order the row carries:
    // two nodes replaying the same row must emit the same rows in the same sequence.
    //
    // `data['VALIDATOR_SIGNATURES']` is the JSON array the chain path (:684) and the
    // mirror applier (:909) both stamp before this settle runs, so both fulfilled
    // routes above the height pay signers. The v4 relay path deliberately stores null
    // there (its signatures are cross_chain relay signatures, not the attestation
    // quorum, :2010), and so does any row whose signature list failed to parse: those
    // fall back to the recomputed responsible set and say so. The fallback is a
    // pure function of the same row and local state, so every node takes it together.
    signerPaySet(request, data, responsible){
        let raw    = data ? data['VALIDATOR_SIGNATURES'] : null;
        let parsed = null;
        if(Array.isArray(raw)) parsed = raw;
        else if(raw != null && String(raw) !== ''){
            try { parsed = JSON.parse(String(raw)); } catch(e){ parsed = null; }
        }

        let seen = new Set();
        let keys = [];
        if(Array.isArray(parsed)){
            for(let s of parsed){
                let pk = (s && s.pubkey != null) ? String(s.pubkey).toLowerCase() : '';
                // A duplicate pubkey would take two shares of one escrow; the verifier
                // already refuses one, and dropping it here keeps that true by construction.
                if(!pk || seen.has(pk)) continue;
                seen.add(pk);
                keys.push(pk);
            }
        }

        if(keys.length === 0){
            getLogger().warn('Attestation fee settle: no verified signatures on the fulfilled response for request ' +
                         String(request.request_id).substring(0,16) +
                         '..., splitting among the recomputed responsible set instead');
            return responsible;
        }

        keys.sort((a, b) => (a < b) ? -1 : (a > b ? 1 : 0));
        return keys;
    },

    // The XCHAIN-denominated broadcast-fee reimbursement owed to the leader for this
    // fulfilled settle, or '0' when the flag-day has not armed, no price is
    // available, or the escrow cannot cover a positive amount. Never throws and never
    // fails a settle: every unusable input resolves to '0' and the legacy full-escrow
    // split runs unchanged.
    //
    // The three pinned decisions this implements (denomination, broadcaster identity,
    // amount bound) and why each is shaped the way it is live in
    // attest_broadcast_fee_gate.js; only the mechanics are here.
    //
    //   `data`        the SETTLING action (v1 response or v4 relay response). Its
    //                 BLOCK_INDEX/BLOCK_TIME anchor both the flag-day test and the
    //                 oracle read, so the conversion is pinned to a block every node
    //                 replays identically rather than to wall-clock time.
    //   `responsible` the request's responsible set, already hash-sorted, so element 0
    //                 IS the lowest-hash member. Callers pass the SAME set the split
    //                 uses; re-deriving it here could not diverge but would double the
    //                 stake query on every fulfilled settle.
    //   `feeCap`      GAS decimals cap, min(8, gasDecimals). The reimbursement is
    //                 floored onto the same decimal grid the split uses, so
    //                 reimbursement + N*share can never exceed the escrow by a ULP.
    async broadcastFeeReimbursement(request, data, responsible, feeAmount, feeCap){
        if(!responsible || responsible.length === 0) return '0';

        // RETIRED at and above the response-mirror flag day. Nobody broadcasts a
        // mirror-era response, so there is no miner fee to reimburse and the carve-out
        // would pay back a cost no validator ever paid. Returning '0' retires all three
        // halves of the carve-out in one place: the caller writes no `attest_bcast` row,
        // leaves `splitPool` as the untouched escrow, and the WHOLE escrow splits among
        // the signers, so per-signer amounts RISE by exactly the retired carve-out for a
        // post-activation request. Below the height nothing here is reached differently
        // and the legacy ledger is byte-identical.
        //
        // Judged on the REQUEST's own block through the one era predicate, never on the
        // settling action's: a request admitted under the legacy rules settles under them
        // however late its response lands, which is the same plane the gate on the chain
        // handler and the mirror applier use. The mirror applier settles through this same
        // routine, so its fee split is retired here too rather than in a second place.
        if(this.isMirrorEraRequest(request)) return '0';

        if(!attestBcastFee.isAttestBroadcastFeeActive(data['BLOCK_INDEX'], this.config['NETWORK']))
            return '0';

        let providerId  = String(request.provider_id || '');
        let capNative   = attestBcastFee.broadcastFeeCapNative(
            providerId, this.providerRegistry.getProvider(providerId));
        if(!this.util.bcgt(capNative, '0')) return '0';

        let prices = await this.broadcastFeePrices(request, data);
        if(!prices) return '0';

        // native → XCHAIN at the settle block: cap * (COIN/USD) / (XCHAIN/USD), floored
        // onto the GAS decimal grid in one bignumber operation (bcmuldivfloor) so no
        // intermediate rounding can differ between nodes.
        let reimbursement = this.util.bcmuldivfloor(
            capNative, prices.coinUsdPrice, prices.xchainUsdPrice, feeCap);
        if(!this.util.bcgt(reimbursement, '0')) return '0';

        // Escrow is the hard ceiling. An author whose escrow is thinner than the
        // allowance reimburses what there is and the split gets nothing, which is the
        // fee-first ordering: the broadcaster's out-of-pocket cost is settled before the
        // reward it is not owed.
        if(this.util.bcgt(reimbursement, feeAmount))
            reimbursement = this.util.bcmulfloor(feeAmount, '1', feeCap);
        return String(reimbursement);
    },

    // Same block-gated, staleness-guarded oracle read the native-coin fee check runs
    // (utility.validateNativeCoinFee), anchored on the settle block's own height and
    // time. A missing or stale feed reimburses ZERO rather than wedging the settle:
    // see the ORACLE LIVENESS note in attest_broadcast_fee_gate.js.
    //
    // Returns the prices, or null when there is nothing usable to convert with, which
    // the caller reimburses zero on.
    async broadcastFeePrices(request, data){
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let prices;
        try {
            prices = await this.util.getFeeOraclePrices(
                this.indexerDb, this.config['COIN'], data['BLOCK_INDEX'], data['BLOCK_TIME'], maxPriceAgeSeconds);
        } catch(e){
            // An infra fault must still fail the block loudly; anything else is a
            // no-reimbursement, not a settle failure.
            rethrowIfInfraFault(e);
            getLogger().warn('Attestation broadcast-fee reimbursement: oracle read failed, reimbursing 0:', e.message);
            return null;
        }
        if(!prices || prices.error){
            getLogger().warn('Attestation broadcast-fee reimbursement: ' +
                         ((prices && prices.error) || 'no prices') + '; reimbursing 0 [request ' +
                         String(request.request_id).substring(0,16) + '...]');
            return null;
        }

        return prices;
    }
};
