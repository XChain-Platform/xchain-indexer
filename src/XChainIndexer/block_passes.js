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
 * XChain Indexer - Block passes
 *
 * Everything a block applies inside its transaction, in consensus order: the opening
 * passes and the block's own transactions, then the settlement, cross-chain, reward and
 * closing passes, then the blocks row, the markets, the supply sanity check and the state
 * roots. The order assigns action indexes, so moving a pass moves every later index in
 * the block. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const stateCommitment    = require('../state_commitment/index.js');
const stateCommitAct     = require('../consensus/gates/state_commitment_gate.js');
const anchorRewardDerive = require('../consensus/anchor_reward_derive.js');
const bridgeSettle       = require('../consensus/bridge_settle.js');
const rollcallClose      = require('../consensus/rollcall_close.js');

module.exports = {

    // Everything a block applies, in consensus order, inside the block transaction's epoch.
    // Moving a pass moves every later action index in the block. Returns the createBlock
    // hash counts [ledger, actions, contracts].
    async runBlockPasses(blk, stateCommitActive){
        await this.runOpeningPasses(blk);
        await this.runSettlementPasses(blk);
        await this.runCrossChainPasses(blk);
        await this.runRewardPasses(blk);
        await this.runClosingPasses(blk);
        return await this.finalizeBlock(blk, stateCommitActive);
    },

    // The VM cache, the genesis injection, matured signing-key rotations, then the block's
    // own transactions.
    async runOpeningPasses({ blockToParse, blockTime, blockTransactions }){
        // Initialize VM compilation cache for this block
        if(this.actions.vm)
            this.actions.vm.beginBlock();

        // Genesis ledger bootstrap: at the configured genesis block, inject the
        // Counterparty/Dogeparty name-ownership ISSUE/TRANSFER actions BEFORE any
        // real transaction, so they take the lowest action indexes in the block.
        // No-op on every other block. See genesis.js.
        await this.genesis.inject(blockToParse, blockTime);

        // Materialize any DELEGATE v1 signing-key rotation whose activation delay
        // has elapsed onto the contract_stakes rows it governs, BEFORE this
        // block's transactions, so the rotated key owns the stake for every read
        // this block makes (VM stake snapshot, UNSTAKE aggregate, SLASH
        // deduction) starting exactly at its activation block. Flag-day gated
        // (CONTRACT_DELEGATION_MATERIALIZE); a no-op below it and on any block
        // with no matured rotation. See utility.processContractDelegationMaterializations.
        await this.util.processContractDelegationMaterializations(this.actions, this.indexerDb, blockToParse);

        // Loop through any block transactions and process them
        for(const tx of blockTransactions)
            await this.actions.processTransaction(tx);
    },

    // Expirations, BET, the cross-chain DEX settlement and the pinned XBRIDGE settle pass.
    async runSettlementPasses({ blockToParse, blockTime }){
        // Check for any expired items (orders, swaps, dispensers)
        await this.util.processExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

        // BET end-of-block pass: latch feeds closed at DEADLINE, then
        // expire feeds past expire_at (system BET_EXPIRE refunds). Both
        // steps are bounded per block (deliberately NOT part of the
        // unbounded processExpirations scan above); see
        // Utility.processBetPasses for the ordering/deferral rules
        await this.util.processBetPasses(this.actions, this.indexerDb, blockToParse, blockTime);

        // Settle this chain's leg of any effective cross-chain DEX matches
        // (validator-signed, mirror-delivered; verified inside CROSS_SETTLE)
        await this.util.processCrossChainSettlements(this.actions, this.indexerDb, blockToParse, blockTime);

        // XBRIDGE settle pass: materialize any hub-mirrored token policy
        // snapshot and then apply this chain's leg of every effective,
        // unapplied bridge transfer (the injected XBRIDGE v2 / v5 legs).
        //
        // THE POSITION IS PINNED AND IS NOT A STYLE CHOICE. It assigns action
        // indexes, so it is consensus-visible, and sitting here - after the
        // cross-chain DEX settlement and before the cross-chain call pass -
        // is what makes a bridged credit bound at block B spendable at B+1 on
        // every node and never at B. Moving it moves every later action index
        // in the block. Runs behind the bridge and policy sync barriers
        // (themselves behind the snapshot barrier), so the mirror rows and the
        // capability rows the quorum is verified against are already present.
        //
        // Throws BridgeProofUnavailableError when the bridge escrow cross-check
        // cannot be supplied a proof yet; processBlock's catch defers the block
        // rather than letting an absence read as a refusal.
        await bridgeSettle.processBridgeSettlePass({
            actions:    this.actions,
            indexerDb:  this.indexerDb,
            util:       this.util,
            mapper:     this.mapper,
            config:     this.config,
            coin:       this.config['COIN'],
            network:    this.config['NETWORK'],
            blockIndex: blockToParse,
            blockTime:  blockTime
        });
    },

    // Cross-chain contract calls, then the pinned ATTEST response pass.
    async runCrossChainPasses({ blockToParse, blockTime }){
        // Cross-chain contract calls: inject executions for dispatches
        // targeting this chain, deliver result callbacks for requests it
        // originated, and expire requests past their deadline (all
        // validator-signed / block-height-deterministic; see
        // utility.processCrossChainCalls)
        await this.util.processCrossChainCalls(this.actions, this.indexerDb, blockToParse, blockTime);

        // Apply any hub-mirrored ATTEST response whose SIGNED effective_time
        // this block's protocol time has reached: verify it through the shared
        // response verifier, synthesize the v1 action, fire the contract
        // callback and settle the request fee (see
        // utility.processAttestationResponses).
        //
        // THE POSITION IS PINNED AND IS NOT A STYLE CHOICE. The VM's
        // attestation snapshot is INCLUSIVE of the current block
        // (db.getAttestationDataForVM), so a response applied before this
        // block's transaction loop would be visible to an EXECUTE inside the
        // same block on a node that had the mirror row and invisible on one
        // that got it a second later. Here, after the transaction loop and
        // before the deadline-expiry sweep, no EXECUTE in B sees a response
        // bound at B and every EXECUTE in B+1 does, on every node. Running it
        // before the sweep is what makes a response satisfied exactly AT the
        // deadline block apply rather than lose to the expiry.
        //
        // BTC-only, matching its sync barrier and for the same reason: all
        // attestation capability stake, and therefore every responsible set,
        // lives on BTC. Inert below the activation height.
        if(this.config['COIN'] === 'BTC')
            await this.util.processAttestationResponses(this.actions, this.indexerDb, blockToParse, blockTime);
    },

    // Anchor/archive reward derivation, the ROLLCALL epoch close and recovery-restored rewards.
    async runRewardPasses({ blockToParse }){
        // Derive matured anchor/archive publisher rewards from the
        // hub-mirrored anchor_reward_attestations rows (re-verifying the XANCPUB
        // quorum against this node's own oracle_publish set, AND re-proving the DOGE
        // anchor mined via this.anchorProof). BTC-only + gated by the
        // derive-relocation flag-day; below the gate (or off-BTC) this is a no-op, so
        // legacy behavior stays byte-identical. Maturity is the fleet-agreed watermark
        // (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY), not the current block. The
        // reward lands at block_index = snapshot_block; a null return / empty set is
        // the common case. Throws AnchorProofUnavailableError when a matured reward
        // cannot be proven either way here, which defers the block rather than
        // deriving a set this node's peers would not.
        await anchorRewardDerive.deriveAnchorRewards(this.indexerDb, this.config, blockToParse, this.anchorProof);

        // ROLLCALL epoch close (validator liveness eviction). BTC-only and
        // gated on ROLLCALL_ACTIVATION, so below the gate (or off-BTC) this is a
        // no-op and legacy behavior stays byte-identical. Sits HERE, before the
        // cooldown sweep below, because an eviction mints real `unstakes` rows at
        // this block and the sweep must see them in the same pass. Throws
        // RollcallProofUnavailableError when the epoch cannot be decided from
        // here, which defers the block rather than reading a silent DOGE peer as
        // a federation-wide absence.
        await rollcallClose.closeRollcallEpochs(this.indexerDb, this.config, blockToParse, this.rollcallProof, this.util);

        // Land any RECOVERY-restored anchor/archive reward whose original derive
        // height this block has reached. A node rebuilt from an ANCHOR archive
        // cannot re-derive these (its attestation mirror is exactly what was
        // lost), so recovery stages them and they materialize here, at the same
        // point in the block and at the same height the derivation above would
        // have minted them: earn-block + the fleet-agreed mirror maturity. Same
        // cheap gate as the createAddress hook, so a node with nothing staged
        // (every node not mid-recovery, and every chain but BTC) pays one COUNT(*)
        // for the process lifetime.
        await this.indexerDb.applyPendingRewardsDueAtBlock(blockToParse);
    },

    // Cancellations, attestation expirations, VOTE finalizations and unstake cooldowns.
    async runClosingPasses({ blockToParse, blockTime }){
        // Check for any cancelled items (dispensers)
        await this.util.processCancellations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Check for any attestation requests past their DEADLINE_BLOCK
        await this.util.processAttestationExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Finalize VOTE polls whose window closed (or that early-decide this block)
        await this.util.processVoteFinalizations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Release tokens for unstakes (capability + contract) past their cooldown
        await this.util.processCooldownCompletions(this.actions, this.indexerDb, blockToParse);
    },

    // Close the VM cache, write the blocks row, update the markets, sanity-check supplies
    // and store the state roots. Returns [ledger, actions, contracts].
    async finalizeBlock({ blockToParse, blockTime, rawBlockTime }, stateCommitActive){
        // Clear VM compilation cache for this block
        if(this.actions.vm)
            this.actions.vm.endBlock();

        // Create record in `blocks` table with hashes of the credits/debits/escrows (ledger) and /actions tables
        // rawBlockTime, not blockTime: this row is what the explorer and the
        // SDK show as the block's timestamp, so it carries the chain's own
        // stamp. It is also the window every other node medians to derive
        // protocol time, so persisting a derived value here would compound.
        let [ledger, actions, contracts] = await this.indexerDb.createBlock(blockToParse, rawBlockTime);

        // Create / Update DEX market information
        await this.util.processMarketUpdates(this.indexerDb, blockToParse, blockTime);

        // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
        await this.indexerDb.sanityCheck(blockToParse);

        // Light-client state commitment: compute + persist
        // the additive state_root + block_merkle_root atomically with the
        // block, after sanityCheck and before commit. Gated by the flag-day;
        // a throw here rolls the whole block back like any other failure.
        if(stateCommitActive){
            let isActivation = stateCommitAct.isStateCommitmentActivationBlock(blockToParse, this.config['NETWORK'], this.config['COIN']);
            await stateCommitment.computeAndStoreRoots(this.indexerDb, this.config['COIN'], this.config['NETWORK'], blockToParse, isActivation);
        }

        return [ledger, actions, contracts];
    }
};
