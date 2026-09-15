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
 * XChain Indexer - Actions class: action dispatch and its observability counters
 *
 * processAction and getActionCounters, mixed into Actions.prototype by actions/index.js,
 * with the two dispatch tables processAction runs. Every handler instance they reach was
 * wired onto the Actions instance by handler_wiring.js.
 *
 ********************************************************************/

// The handler dispatch table, in two runs so neither is one long function. Module functions
// called with the Actions instance as `this` (see processAction) rather than class methods,
// so a context that borrows only Actions.prototype.processAction still dispatches. Every
// line keeps the `if(action=='X') await this.<handler>.parse(` shape: the manifest
// conformance test reads that shape out of this file as the dispatch table.
async function dispatchCoreAction(action, params, data, error){
    if(action=='ADDRESS')            await this.actionAddress.parse(params, data, error);
    if(action=='AIRDROP')            await this.actionAirdrop.parse(params, data, error);
    if(action=='BATCH')              await this.actionBatch.parse(params, data, error);
    if(action=='BET')                await this.actionBet.parse(params, data, error);
    if(action=='BET_EXPIRE')         await this.actionBetExpire.parse(params, data, error);
    if(action=='BROADCAST')          await this.actionBroadcast.parse(params, data, error);
    if(action=='CALLBACK')           await this.actionCallback.parse(params, data, error);
    if(action=='COINPAY')             await this.actionCoinpay.parse(params, data, error);
    if(action=='COINPAY_EXPIRE')     await this.actionCoinpayExpire.parse(params, data, error);
    if(action=='DESTROY')            await this.actionDestroy.parse(params, data, error);
    if(action=='DISPENSER')          await this.actionDispenser.parse(params, data, error);
    if(action=='DISPENSER_CLOSE')    await this.actionDispenserClose.parse(params, data, error);
    if(action=='DISPENSER_EXPIRE')   await this.actionDispenserExpire.parse(params, data, error);
    if(action=='DISPENSE')           await this.actionDispense.parse(params, data, error);
    if(action=='DIVIDEND')           await this.actionDividend.parse(params, data, error);
    if(action=='FILE')               await this.actionFile.parse(params, data, error);
    if(action=='ISSUE')              await this.actionIssue.parse(params, data, error);
    if(action=='LIST')               await this.actionList.parse(params, data, error);
    if(action=='LINK')               await this.actionLink.parse(params, data, error);
    if(action=='MINT')               await this.actionMint.parse(params, data, error);
    if(action=='MESSAGE')            await this.actionMessage.parse(params, data, error);
    if(action=='ORDER')              await this.actionOrder.parse(params, data, error);
    if(action=='ORDER_EXPIRE')       await this.actionOrderExpire.parse(params, data, error);
    if(action=='ORDER_MATCH')        await this.actionOrderMatch.parse(params, data, error);
    if(action=='SLEEP')              await this.actionSleep.parse(params, data, error);
    if(action=='SEND')               await this.actionSend.parse(params, data, error);
    if(action=='SWAP')               await this.actionSwap.parse(params, data, error);
    if(action=='SWAP_EXPIRE')        await this.actionSwapExpire.parse(params, data, error);
    if(action=='SWAP_MATCH')         await this.actionSwapMatch.parse(params, data, error);
    if(action=='CROSS_SETTLE')       await this.actionCrossSettle.parse(params, data, error);
    if(action=='SWEEP')              await this.actionSweep.parse(params, data, error);
    if(action=='UNKNOWN')            await this.actionUnknown.parse(params, data, error);
}

// VM, staking, oracle, attestation, anchor, cross-chain and validator-tier actions.
async function dispatchProtocolAction(action, params, data, error){
    // VM actions
    if(action=='DEPLOY')             await this.actionDeploy.parse(params, data, error);
    if(action=='EXECUTE')            await this.actionExecute.parse(params, data, error);
    if(action=='DEPOSIT')            await this.actionDeposit.parse(params, data, error);
    if(action=='WITHDRAW')           await this.actionWithdraw.parse(params, data, error);
    if(action=='VOTE')               await this.actionVote.parse(params, data, error);

    // Staking actions (DELEGATE handles both rotate v0/v1 and revoke v2/v3 internally)
    if(action=='STAKE')              await this.actionStake.parse(params, data, error);
    if(action=='UNSTAKE')            await this.actionUnstake.parse(params, data, error);
    if(action=='DELEGATE')           await this.actionDelegate.parse(params, data, error);
    if(action=='COLLECT')            await this.actionCollect.parse(params, data, error);
    if(action=='SLASH')              await this.actionSlash.parse(params, data, error);

    // PRICE action (validator snapshots and user oracles)
    if(action=='PRICE')              await this.actionPrice.parse(params, data, error);

    // Attestation framework: handler dispatches on VERSION (v0=request, v1=response, v2=expire)
    if(action=='ATTEST')             await this.actionAttest.parse(params, data, error);

    // ANCHOR: DOGE-only on-chain state commitments (handler dispatches on VERSION:
    // v0=checkpoint bundle, v1=archive head, v2=archive continuation chunk; the
    // pre-restart v3-v7 set no longer parses)
    if(action=='ANCHOR')             await this.actionAnchor.parse(params, data, error);

    // Cross-chain contract calls: XCALL (VM-emitted request / synthetic expiry),
    // XEXEC (system-injected, mirror-driven target-chain execution)
    if(action=='XCALL')              await this.actionXcall.parse(params, data, error);
    if(action=='XEXEC')              await this.actionXexec.parse(params, data, error);

    // Cross-chain token bridge: XBRIDGE (v0/v3 lock, v1/v4 burn; a broadcast v2/v5 is
    // refused here, the injected settle legs are applied by bridge_settle.js)
    if(action=='XBRIDGE')            await this.actionXbridge.parse(params, data, error);

    // Full-node possession-proof verdict (verified-validator tier)
    if(action=='NODEPROOF')          await this.actionNodeproof.parse(params, data, error);
    if(action=='ROLLCALL')           await this.actionRollcall.parse(params, data, error);
}

module.exports = {

    // Generalized function to handle parsing and processing a specific ACTION
    // NOTE: If the action is UNKNOWN, fail silently (prevent crashing indexer on unsupported actions)
    async processAction(action, params, data, error){
        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // ORDER_MATCH / SWAP_MATCH are dispatched by the ORDER / SWAP handler with the
        // ORIGINATING action's OWN record (order.js / swap.js), and they overwrite its
        // STATUS and ACTION_INDEX with the match's (order_match.js sets STATUS to
        // 'pending_coinpay' for a native-coin leg, and takes ACTION_INDEX for the match row).
        // On the real path that is invisible: the block loop discards processTransaction's
        // return value and every row was already written from the handler's own state. The
        // read-only fee-quote DRY RUN is its ONLY consumer, so without this snapshot it
        // reports the MATCH's verdict as the quoted action's - and an ORDER that fills
        // instantly against a native-coin counterparty is then quoted
        // `valid:false, error:"pending_coinpay", xchainFee:null`, i.e. indistinguishable from
        // a real rejection, for an action the chain accepts. That refused the taker side of
        // the whole CoinPay lane in every wallet that pre-flights (measured 2026-07-29 on LTC
        // regtest). Captured here rather than in the two handlers so one rule covers both, and
        // scoped per transaction by processTransaction above. These two actions are never
        // top-level: the decoder cannot produce them and the public quote deny-lists them.
        if((action == 'ORDER_MATCH' || action == 'SWAP_MATCH') && data && this._primaryVerdict == null)
            this._primaryVerdict = { status: data['STATUS'], actionIndex: data['ACTION_INDEX'] };

        // Deterministic index-id pre-pass: register the NEW wire-field addresses this
        // action introduces, in byte-sorted VALUE order, BEFORE the handler runs. This
        // pins each new address's index id to the VALUE it carries rather than to the
        // order the handler happens to intern it, so the wire ^<id> address form resolves
        // identically on every node and across code refactors. Runs after createActionIndex
        // (which already registered SOURCE first) and covers the BATCH path too, since
        // batch.js dispatches each sub-action back through processAction.
        await this.assignActionAddressIds(action, params, data, error);

        // Process the action with the correct handler (dispatchCoreAction, then
        // dispatchProtocolAction; at most one line of the two tables matches any ACTION).
        await dispatchCoreAction.call(this, action, params, data, error);
        await dispatchProtocolAction.call(this, action, params, data, error);

        // Increment the in-memory observability counter for this action type. STATUS
        // is 'valid' for accepted actions and an 'invalid: ...' string (or undefined
        // when an earlier gate short-circuits) for rejected ones. This read happens
        // AFTER the handler has written its final status, so the bucket is accurate.
        // Pure observability: not on any hashed path and not persisted.
        let bucket = this._actionCounters[action];
        if(!bucket){
            bucket = { accepted: 0, rejected: 0 };
            this._actionCounters[action] = bucket;
        }
        if(data['STATUS'] === 'valid')
            bucket.accepted++;
        else
            bucket.rejected++;
    },

    // Return a snapshot of the per-type accepted/rejected counters accumulated since
    // this process started. The caller receives a plain object (not a live reference)
    // so mutations outside this class cannot corrupt the counters. Surfaced by the
    // health endpoint as a lightweight operational signal; never on any consensus path.
    getActionCounters(){
        let out = {};
        for(let type of Object.keys(this._actionCounters)){
            let b = this._actionCounters[type];
            out[type] = { accepted: b.accepted, rejected: b.rejected };
        }
        return out;
    }

};
