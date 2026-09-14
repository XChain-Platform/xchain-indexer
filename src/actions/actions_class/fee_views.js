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
 * XChain Indexer - Actions class: raw dry-run and fee schedule views
 *
 * computeFeeQuoteDryRun (the regtest-only `feequotedryrun` RPC) and getFeeSchedule (the
 * public fee schedule), mixed into Actions.prototype by actions/index.js. Both are
 * read-only: the dry-run always rolls back and the schedule only reads.
 *
 ********************************************************************/

// Which database the fee schedule's price read came out of. Resolved exactly the way
// util.getFeeOraclePrices resolves it, so the disclosure cannot drift from the
// read it describes.
//
// This exists because the resolution is INVISIBLE from outside the process and is
// decided by one env var on the indexer alone. Set HUB_DB_NAME here and every price
// lookup moves to the hub DB; anything off-box that seeds prices (the e2e fixtures)
// keeps writing wherever ITS own env points, and the only symptom is every priced
// action failing `no current oracle price` with both databases looking healthy.
// Disclosing the resolved source lets a caller follow the indexer instead of
// modelling it.
//
// The NAME is withheld on mainnet, where this is a public read surface and an
// internal database name is not the client's business; the boolean is the part a
// client needs (single-host node vs hub-backed one) and is always disclosed.
function feePriceSource(actions){
    let priceDb = (actions.indexerDb && actions.indexerDb.indexer && actions.indexerDb.indexer.hubDb)
        ? actions.indexerDb.indexer.hubDb
        : actions.indexerDb;
    let mainnet = String(actions.config['NETWORK'] || '').toLowerCase() === 'mainnet';
    return {
        hubDb:    !!(priceDb && priceDb !== actions.indexerDb),
        database: (!mainnet && priceDb && priceDb.dbName) ? priceDb.dbName : null
    };
}

module.exports = {

    // Raw fee/validity dry-run (the regtest-only `feequotedryrun` JSON-RPC). Same engine as the
    // public feequote (dryRunAction) but with NO deny-list, NO admission cap, the caller's
    // literal `feeOutputs` (no probe injection: absent outputs exercise the BTC xchain-balance
    // fallback / LTC-DOGE mandatory-native rejection exactly as a real broadcast would), and
    // the full block watchdog as its timeout. That unrestricted surface (VM actions on demand,
    // attacker-shaped outputs) is why it stays OPT-IN: the RPC is unregistered unless
    // INDEXER_NETWORK=regtest AND INDEXER_ENABLE_DRYRUN is set (api.js ENABLE_DRYRUN), and is
    // API-key-gated when a key is configured. The 06-18 trial's AUTO_INCREMENT concern is
    // resolved (block hashes cover canonical strings; in-transaction index ids are dense-
    // explicit and roll back), so the gate is about compute, not consensus.
    async computeFeeQuoteDryRun({ action, params, source, feeOutputs }){
        action = String(action || '').toUpperCase();
        if(!Array.isArray(params)) params = String(params == null ? '' : params).split('|');
        params = params.map(v => String(v).trim());

        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let nativeEnabled  = !!(feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

        let run = await this.dryRunAction({
            action, params, source, feeOutputs,
            probeFeeDestination: null,
            timeoutMs: this.config['BLOCK_PROCESS_TIMEOUT'],
            label: 'feequotedryrun ' + (action || '')
        });

        let valid  = (run.status === 'valid');
        let result = {
            supported:      true,
            dryRun:         true,
            action:         action,
            coin:           coin,
            feeDestination: feeDestination,
            blockIndex:     run.blockIndex,
            blockTime:      run.blockTime,
            valid:          valid,
            status:         run.status,
            error:          valid ? null : (run.error || run.status || 'dry-run produced no status'),
            xchainFee:      (run.xchainFee == null) ? null : this.util.bcformat(this.util.bcnum(run.xchainFee), 8),
            requiredFeeNative: null,
            feeSupported:   false
        };

        // Native-fee sizing for the extracted fee, merged without letting a pricing failure
        // (missing/stale oracle) overwrite the handler's validity verdict: on this raw surface
        // the handler verdict is the headline and sizing is best-effort.
        if(valid && nativeEnabled){
            // Carry blockTime: it is what priceFeeQuote anchors the whole price read on (round
            // selection, staleness, flag-day gate). Without it this raw surface would silently
            // fall back to wall clock and quote off a different price set than the chain.
            let priced = await this.priceFeeQuote({ blockIndex: run.blockIndex, blockTime: run.blockTime }, run.xchainFee, undefined);
            if(priced.valid !== false){
                result.feeSupported      = true;
                result.oracleRound       = priced.oracleRound;
                result.xchainUsdPrice    = priced.xchainUsdPrice;
                result.coinUsdPrice      = priced.coinUsdPrice;
                result.expectedNative    = priced.expectedNative;
                result.minAcceptable     = priced.minAcceptable;
                result.maxAcceptable     = priced.maxAcceptable;
                result.requiredFeeNative = priced.requiredFeeNative;
                result.requiredFeeSats   = priced.requiredFeeSats;
            } else {
                result.feeError = priced.error;
            }
        }

        return result;
    },

    // Read-only fee schedule + current oracle prices for native-coin fee payment. Lets a client
    // display the gas schedule / tolerance band and do a rough native-fee estimate before issuing
    // a per-action computeFeeQuote. Surfaced publicly via the explorer's /{COIN}/api/feeschedule
    // proxy. Never persists.
    async getFeeSchedule(){
        let coin           = this.config['COIN'];
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        let enabled        = !!(feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let blockIndex     = await this.indexerDb.getLatestBlockIndex();
        let blockTime      = await this.indexerDb.getBlockTime(blockIndex);

        // Current oracle prices (best-effort; a missing/stale feed doesn't fail the schedule call;
        // prices.available=false tells the client native fees can't be priced right now).
        // Anchored on the tip block's time for the same reason priceFeeQuote is: this
        // view exists to predict what the chain will charge, so it has to read the prices the
        // chain reads, not the ones the operator's clock happens to agree with.
        let chainTime = Number(blockTime);
        let refTime   = Number.isFinite(chainTime) ? chainTime : Math.floor(Date.now() / 1000);
        let prices    = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, refTime, maxPriceAgeSeconds);
        let priceSource = feePriceSource(this);

        let priceInfo = prices.error
            ? { available: false, error: prices.error }
            : {
                available:   true,
                xchainUsd:   this.util.bcformat(prices.xchainUsdPrice, 8),
                coinUsd:     this.util.bcformat(prices.coinUsdPrice, 8),
                oracleRound: prices.oracleRound
              };

        return {
            coin:               coin,
            network:            this.config['NETWORK'],
            nativeFeeEnabled:   enabled,
            feeDestination:     enabled ? feeDestination : null,
            gasPrice:           this.config['GAS_PRICE'] || null,
            gasSchedule:        this.config['GAS_SCHEDULE'] || null,
            toleranceMin:       this.config['FEE_TOLERANCE_MIN'] || '0.95',
            toleranceMax:       this.config['FEE_TOLERANCE_MAX'] || '1.10',
            maxPriceAgeSeconds: maxPriceAgeSeconds,
            blockIndex:         blockIndex,
            // The instant the price read above was judged against, so a client can tell a stale
            // feed from an indexer whose tip is behind.
            blockTime:          blockTime,
            prices:             priceInfo,
            // See above: where price_snapshots / oracle_prices were actually read from.
            priceSource:        priceSource
        };
    }
};
