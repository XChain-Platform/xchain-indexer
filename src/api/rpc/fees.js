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
 * XChain Indexer - JSON-RPC fee family: fee quotes, the fee schedule, pre-flight and the opt-in dry-run.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// The opt-in dry-run is decided here, once per boot, from the ENABLE_DRYRUN flag
// src/api.js derives; see that flag's note for why the method is gated at all.
function buildFeesRpc(ctx){
    let rpc = Object.assign({}, feeQuoteRpc(ctx), oracleFeeQuoteRpc(ctx), preflightRpc(ctx));

    // Unregister the opt-in dry-run unless explicitly enabled on a regtest node
    // (see ENABLE_DRYRUN). Removing the method means a non-regtest / unflagged node
    // returns method-not-found instead of exposing unauthenticated VM execution.
    if(!ctx.ENABLE_DRYRUN)
        delete rpc.feequotedryrun;
    else
        getLogger().warn('WARNING: feequotedryrun is ENABLED (regtest + INDEXER_ENABLE_DRYRUN). It runs the real VM in a rolled-back txn; keep this node isolated.');
    return rpc;
}

function feeQuoteRpc({ indexer }){
    return {
        // Read-only native-coin fee pre-flight. Phase 2: runs the REAL action handler in a
        // forced-rollback dry-run (Actions.computeFeeQuote), so `valid`/`error` are the
        // handler's own verdict for ANY quotable action (class-A fee/price failures AND
        // class-B action failures: insufficient balance, taken ticker, ...), and the fee is
        // the handler's staged number valued at current oracle prices, judged (optionally)
        // against the on-chain tolerance. Nothing persists. VM/compound actions never reach the
        // dry-run engine here: DEPLOY/EXECUTE answer with a schedule-priced fee carrying
        // `valid:null` (payable, unverified), XEXEC/BATCH stay unquotable. Quotes are
        // admission-capped and time-boxed so this public read can't starve the block loop
        // (see computeFeeQuote).
        // Public read (surfaced to wallets/SDK via the explorer proxy); not a write or
        // federation method.
        // Body: { action, params, source, feeOutputSats? }
        async feequote({action, params, source, feeOutputSats}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computeFeeQuote({ action, params, source, feeOutputSats });
            } catch (err) {
                getLogger().error('feequote error:', err);
                return { error: 'failed to compute fee quote' };
            }
        },

        // Read-only native-coin fee schedule + current oracle prices. Lets a client display the
        // gas schedule / tolerance band and rough-estimate a native fee before a per-action
        // feequote. Public read (surfaced to wallets/SDK via the explorer proxy).
        async feeschedule(){
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.getFeeSchedule();
            } catch (err) {
                getLogger().error('feeschedule error:', err);
                return { error: 'failed to fetch fee schedule' };
            }
        },
    };
}

// Oracle usage fee quote. A Mode B dispenser (ORACLE_ADDRESS set) must
// carry a native-coin output paying the oracle operator, sized from the escrow
// this action adds. A payer calls this to learn the amount, then adds the output.
//
// Backed by the SAME utility.quoteOracleFee() the consensus check calls, so a
// quote and an acceptance can never drift apart; a drift would either reject an
// honest create or underpay the oracle. Unlike feequote this needs no dry-run:
// the amount is a pure function of the two oracle prices and the escrow.
//
// Body: { oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime? }
// blockTime defaults to the indexer's current tip time; a caller quoting for a
// specific block may pass one.
function oracleFeeQuoteRpc({ indexer }){
    return {
        async oraclefeequote({oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime}){
            if(!oracleAddress || !giveTick || !fiatCode)
                return { error: 'oracleAddress, giveTick and fiatCode are required' };
            if(!indexer.indexerDb || !indexer.util)
                return { error: 'indexer not ready' };
            try {
                let ts = Number(blockTime);
                if(!Number.isFinite(ts) || ts <= 0){
                    let tip = await indexer.indexerDb.getLatestBlockIndex();
                    ts = Number(await indexer.indexerDb.getBlockTime(tip)) || 0;
                }
                if(!Number.isFinite(ts) || ts <= 0)
                    return { error: 'no indexed block to quote against' };
                let quote = await indexer.util.quoteOracleFee(ts, {
                    ORACLE_ADDRESS: oracleAddress,
                    GIVE_COIN:      giveCoin || indexer.config['COIN'],
                    GIVE_TICK:      giveTick,
                    FIAT_CODE:      fiatCode,
                    GET_COIN:       getCoin  || indexer.config['COIN'],
                    GIVE_ESCROW:    giveEscrow,
                }, indexer.indexerDb);
                if(!quote.valid)
                    return { valid: false, error: quote.error };
                let native = indexer.util.bcformat(quote.expectedFee, 8);
                return {
                    valid:             true,
                    oracleAddress:     oracleAddress,
                    blockTime:         ts,
                    requiredFeeNative: native,
                    requiredFeeSats:   Number(indexer.util.bcformat(
                                          indexer.util.bcmul(quote.expectedFee, '100000000', 0), 0)),
                    belowDust:         !!quote.belowDust,
                    note:              quote.belowDust
                        ? 'fee is below the dust threshold; no output required'
                        : 'add a native-coin output of at least this amount to ' + oracleAddress
                };
            } catch (err) {
                getLogger().error('oraclefeequote error:', err);
                return { error: 'failed to compute oracle fee quote' };
            }
        },
    };
}

function preflightRpc({ indexer }){
    return {
        // Public validity-first pre-flight: "would the indexer accept this action?"
        // decoupled from native-coin fee support. Same forced-rollback dry-run engine and the
        // same admission cap / timeout / guardInert as feequote, but the response is the
        // action's validity STATUS (not a fee band), and supported:true whenever the handler
        // actually ran. VM actions stay denylisted; settlement/lifecycle actions stay
        // feeExempt. Height-keyed memo collapses same-height re-runs. Public read (surfaced to
        // wallets/SDK via the explorer /{COIN}/api/preflight proxy); NOT gated like
        // feequotedryrun. Never persists.
        // `feeMode` ('xchain' | 'native', optional) says how the caller's real transaction will
        // settle the protocol fee, because the verdict differs: the XCHAIN mode debits
        // the payer's balance and the native mode pays a coin output. Omitted, the indexer picks
        // the mode the chain itself defaults to.
        // Body: { action, params, source, feeMode? }
        async preflight({action, params, source, feeMode}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computePreflight({ action, params, source, feeMode });
            } catch (err) {
                getLogger().error('preflight error:', err);
                return { error: 'failed to compute pre-flight' };
            }
        },

        // OPT-IN raw dry-run: same engine as feequote but with no action deny-list, no
        // admission cap, the caller's literal feeOutputs (no probe injection), and the full
        // block watchdog as timeout. That unrestricted surface (VM actions on demand) is why
        // it stays regtest-gated (see ENABLE_DRYRUN) even though the default feequote now
        // dry-runs publicly. Never persists.
        // Body: { action, params, source, feeOutputs? }
        async feequotedryrun({action, params, source, feeOutputs}){
            if(!action || typeof action !== 'string')
                return { error: 'action is required' };
            if(!indexer.indexerDb || !indexer.actions)
                return { error: 'indexer not ready' };
            try {
                return await indexer.actions.computeFeeQuoteDryRun({ action, params, source, feeOutputs });
            } catch (err) {
                getLogger().error('feequotedryrun error:', err);
                return { error: 'dry-run failed: ' + ((err && err.message) ? err.message : String(err)) };
            }
        },
    };
}

module.exports = { buildFeesRpc };
