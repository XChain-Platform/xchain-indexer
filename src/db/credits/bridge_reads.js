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
 * XChain Indexer - Database mixin part: credits, the bridge reads
 *
 * The getbridgebalances and getbridgeescrowproof reads over the credits/debits
 * ledger. Merged into the credits mixin by db/credits/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// getbridgeescrowproof (base spec section 12, D2/D70): the proof-producing read shares
// the SAME key/leaf derivation and the SAME persistent, content-addressed SMT the block
// path commits, never a rebuilt in-memory tree, so a proof this method hands out can only
// ever match what was actually committed.
const bridgeMerkle = require('../../consensus/merkle.js');
const bridgeStateCommitment = require('../../state_commitment/index.js');
// state_root_version is a DERIVED-per-height quantity (api.js getblockhashes is the ONLY
// place it is MINTED), never the static merkle.STATE_ROOT_VERSION constant: a static
// comparison refuses every checkpoint cut once a sub-tree slot arms. getBridgeEscrowProof
// re-derives it here as a guard against handing out an envelope built from a stale or
// mis-migrated state_checkpoints row.
const bridgeStateSubtree = require('../../consensus/gates/state_subtree_gate.js');
// The {error} text served when this node's own roots disagree with the signed checkpoint. The
// consumer reads every {error} answer as an unavailable proof and defers the block.
const { ESCROW_STATE_DIVERGED } = require('../../consensus/bridge_proof_client/stall.js');
// This node's own sub-roots, and the rule for how long a divergence from the signed
// checkpoint is answered instead of an envelope (escrow_divergence.js).
const { subRootsOf, divergenceAnswerStands } = require('./escrow_divergence.js');

// The state_checkpoints row getBridgeEscrowProof binds its envelope to, or null when this
// height has none or its stamped version cannot be trusted.
//
// state_checkpoints is hub-mirrored, so it lives wherever the mirror writes: the
// hub-DB copy on a distributed deployment (where the ledger database's copy of the
// table exists but stays empty) and this database only on a single-host one. The
// ledger connection is the wrong place to ask on every standing indexer, and an
// origin indexer asked there can never produce a proof, which stalls every in leg
// on the destination's proof barrier. Same handle the proof client reads through.
async function readVerifiedCheckpoint(db, chain, network, height){
    let cpRows = await db.mirrorDb().doQueryStrict(
        `SELECT checkpoint_seq, snapshot_block, state_root, state_root_version
             FROM state_checkpoints WHERE chain=? AND network=? AND block_index=? ORDER BY checkpoint_seq DESC LIMIT 1`,
        [chain, network, height]);
    if(!cpRows.length) return null;
    let cp = cpRows[0];

    // Fail closed rather than hand out an envelope built from a stale or mis-migrated
    // checkpoint row: the STAMPED version relayed below must already agree with what
    // this node's own maps derive at the checkpoint's own height, or this producer has
    // nothing trustworthy to offer. The consumer (bridge_checkpoint_check.js) repeats
    // this exact derivation independently against the STAMPED value it receives; this
    // guard never substitutes the derived value for the stamped one -- doing that would
    // make the consumer's own version check vacuous (it would always agree with itself)
    // and silently drop the one binding that catches a checkpoint whose signed version
    // disagrees with its own sub-root leaf set.
    let derivedVersion = bridgeStateSubtree.stateRootVersion(height, network, chain);
    if(derivedVersion === null || Number(cp.state_root_version) !== derivedVersion)
        return null;

    return cp;
}

// The address's net tick balance as of `height`, bounded through the actions join so it
// reads the ledger at that block, never the current one.
async function ledgerBalanceAt(db, address, tick, height){
    let balRows = await db.doQueryStrict(
        `SELECT
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN actions         ac ON (ac.action_index=c.action_index)
                    INNER JOIN index_addresses ad ON (ad.id=c.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=c.tick_id)
                    WHERE ad.address=? AND ti.tick=? AND ac.block_index<=?) AS cr,
                (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN actions         ac ON (ac.action_index=d.action_index)
                    INNER JOIN index_addresses ad ON (ad.id=d.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=d.tick_id)
                    WHERE ad.address=? AND ti.tick=? AND ac.block_index<=?) AS dr`,
        [address, tick, height, address, tick, height]);
    let cr      = balRows.length ? String(balRows[0].cr) : '0';
    let dr      = balRows.length ? String(balRows[0].dr) : '0';
    return db.util.bcstr(db.util.bcsub(cr, dr, 18));
}


module.exports = {

    // Chain-state half of getbridgeinvariant (getbridgebalances RPC, base spec section 13;
    // CrossChainBridgeEngine.readBridgeBalances is the caller): the tick's supply on THIS
    // chain plus the balance held at every ADDRESS.BRIDGE_<COIN> role address this chain's
    // own config carries.
    //
    // supply prefers the native `tokens.supply` row when one exists here: on the origin
    // chain that is every unit ever minted, circulating plus escrowed (base spec section 13),
    // which is what the MAX_SUPPLY cap binds against. A tick with no native row on this
    // chain is a bridged copy with no ISSUE history here, so supply falls back to the
    // ledger-wide net (SUM(credits)-SUM(debits) over every address on this chain), the
    // "shadow of its escrow" the base spec names for a foreign chain's holding.
    //
    // escrow is keyed by the BARE coin (never the BRIDGE_ prefix): the hub's escrowFor
    // accepts either spelling, and this is the form the seam pins.
    async getBridgeBalances(tick){
        let t      = String(tick);
        let native = await this.doQuery(
            `SELECT tk.supply FROM tokens tk INNER JOIN index_tickers ti ON (ti.id=tk.tick_id) WHERE ti.tick=? LIMIT 1`,
            [t]);
        let supply;
        if(native.length > 0 && !this.util.isNull(native[0].supply)){
            supply = String(native[0].supply);
        } else {
            let rows = await this.doQuery(
                `SELECT
                    (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                        INNER JOIN index_tickers ti ON (ti.id=c.tick_id) WHERE ti.tick=?) AS cr,
                    (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                        INNER JOIN index_tickers ti ON (ti.id=d.tick_id) WHERE ti.tick=?) AS dr`,
                [t, t]);
            let cr = rows.length ? String(rows[0].cr) : '0';
            let dr = rows.length ? String(rows[0].dr) : '0';
            supply = this.util.bcstr(this.util.bcsub(cr, dr, 18));
        }
        let escrow    = {};
        let addresses = (this.config && this.config['ADDRESS']) || {};
        for(let role of Object.keys(addresses)){
            if(role.substr(0, 7) !== 'BRIDGE_') continue;
            let coin = role.substr(7);
            let addr = addresses[role];
            let rows = await this.doQuery(
                `SELECT
                    (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                        INNER JOIN index_addresses ad ON (ad.id=c.address_id)
                        INNER JOIN index_tickers   ti ON (ti.id=c.tick_id)
                        WHERE ad.address=? AND ti.tick=?) AS cr,
                    (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                        INNER JOIN index_addresses ad ON (ad.id=d.address_id)
                        INNER JOIN index_tickers   ti ON (ti.id=d.tick_id)
                        WHERE ad.address=? AND ti.tick=?) AS dr`,
                [addr, t, addr, t]);
            let cr = rows.length ? String(rows[0].cr) : '0';
            let dr = rows.length ? String(rows[0].dr) : '0';
            escrow[coin] = this.util.bcstr(this.util.bcsub(cr, dr, 18));
        }
        return { supply: supply, escrow: escrow };
    },

    /**
     * The D2 proof envelope (getbridgeescrowproof RPC), the shape bridge_checkpoint_check.js's
     * header documents and verifyEscrowAgainstCheckpoint verifies. Producer-side only: this
     * never chooses or verifies a checkpoint's signatures (the caller's obligation, per that
     * module's header), it only reports what THIS chain committed at `block_index` and lets
     * the caller bind its own already-verified checkpoint to it.
     *
     * sub_roots and the checkpoint identity both come from this chain's own committed
     * history at EXACTLY block_index: a height with no roots or no signed checkpoint yet
     * produces no proof at all, never an approximation from the nearest neighbour.
     *
     * The balance is read as of block_index (bounded through the actions join, never the
     * current ledger), then PROVEN against the persisted balances_root through the SAME
     * content-addressed store (state_tree_nodes) the block path writes -- never a rebuilt
     * in-memory tree, which could silently diverge from what was actually committed. The
     * computed balance and the persisted leaf are cross-checked before anything is returned:
     * a mismatch (drift, an unindexed reorg window, a pruned node) fails closed to null
     * rather than handing out an unverifiable proof.
     *
     * DIVERGED STATE. When the committed sub_roots at block_index do not reassemble to the
     * signed checkpoint's state_root, this node's state at that height is not the signed state:
     * it reorged below the checkpoint, or it sits on a minority fork. It then answers
     * { error: ESCROW_STATE_DIVERGED } instead of an envelope no consumer can verify, and the
     * consumer defers its block as for any unavailable proof, so a consumer whose peer is on a
     * minority fork waits for a correct peer instead of committing a block without the leg.
     *
     * THE BOUND. The answer holds only until this node also holds a quorum-verified checkpoint
     * DIVERGENCE_SETTLE_BLOCKS or more past block_index whose signed root its own state
     * reproduces (escrow_divergence.js divergenceSettled). That is the proof that the federation followed this
     * node's chain past the reorg, so the old checkpoint's root exists on no honest node and
     * waiting cannot produce a verifying proof. From then on this node serves its envelope for
     * the old height again, the consumer's reassembly refuses it, and every consumer skips the
     * leg at the same block as below this guard. A minority-fork node never reproduces a later
     * signed root, so while the stream runs it keeps answering DIVERGED and only the consumers
     * asking it wait. This is RPC behaviour only: the consumer's verdict for any envelope is
     * unchanged.
     *
     * THE STOPPED STREAM. A later checkpoint can only settle the divergence while the
     * federation is still signing. When the newest signed row this node's mirror holds is
     * CHECKPOINT_STREAM_STALL_BLOCKS or more below its own tip (checkpointStreamStopped), no
     * such checkpoint is coming, and a hub that refuses to sign while a chain waits on this
     * proof would hold the wait forever. The answer is then released the same way: this node
     * serves its envelope, the consumer refuses it, and the leg is skipped. It is not sticky:
     * a fresh row in the mirror puts the answer back. RESIDUAL, STATED: a node on a minority
     * fork whose mirror is also cut off from the hub for that long cannot tell it from a hub
     * that stopped, so its consumers skip a leg that consumers asking an honest node apply.
     * That is the price of the wait having an end, and it needs both faults at once.
     *
     * @param {string} address     - the escrow address being proven
     * @param {string} tick        - the native tick (never the rooted form)
     * @param {number} block_index - the height to prove the balance AT
     * @returns {Promise<Object|null>} the envelope, { error } while this node's state at that
     *          height diverges from the signed checkpoint and the divergence is not settled,
     *          or null when it cannot be produced
     */
    async getBridgeEscrowProof(address, tick, block_index){
        let chain   = this.config['COIN'];
        let network = this.config['NETWORK'];
        let height  = Number(block_index);
        if(!Number.isFinite(height) || !Number.isInteger(height) || height < 0)
            return null;

        let rootRows = await this.doQueryStrict(
            `SELECT balances_root, stakes_root, contract_state_root
             FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1`,
            [chain, network, height]);
        if(!rootRows.length) return null;
        let rootRow = rootRows[0];

        let subRoots = subRootsOf(this, rootRow);

        // The signed checkpoint at exactly this height, read where the mirror writes it and
        // refused when its stamped version disagrees with this node's own derivation.
        let cp = await readVerifiedCheckpoint(this, chain, network, height);
        if(!cp) return null;

        // This node's own roots must reproduce it, or the divergence must be settled by a later
        // checkpoint, or the checkpoint stream that could settle it must have stopped.
        if(await divergenceAnswerStands(this, chain, network, height, subRoots, cp))
            return { error: ESCROW_STATE_DIVERGED };

        let balance = await ledgerBalanceAt(this, address, tick, height);

        let key   = bridgeMerkle.balanceKey(chain, network, address, tick);
        let smt   = new bridgeStateCommitment.PersistentSMT(new bridgeStateCommitment.DbNodeStore(this));
        let proof = await smt.prove(rootRow.balances_root, key);

        // Self-check: the leaf the persistent tree actually holds at this key must match
        // the ledger balance just computed (delete-on-zero means a zero balance proves as
        // ABSENCE, never a zero-valued leaf), or the two have drifted and no proof is
        // producible.
        let expectLeaf = this.util.bcgt(balance, '0') ? bridgeMerkle.toHex(bridgeMerkle.amountLeaf(balance)) : null;
        if(expectLeaf !== proof.leaf_value)
            return null;

        return {
            chain:       chain,
            network:     network,
            block_index: height,
            sub_roots:   subRoots,
            address:     address,
            tick:        tick,
            balance:     balance,
            balance_proof: { siblings: proof.siblings },
            checkpoint: {
                chain:              chain,
                network:            network,
                block_index:        height,
                checkpoint_seq:     Number(cp.checkpoint_seq),
                snapshot_block:     Number(cp.snapshot_block),
                state_root:         cp.state_root,
                state_root_version: Number(cp.state_root_version)
            }
        };
    },

};

// Reused by proof-producing database reads without installing another public
// method on Database.prototype when credits/index.js spreads this mixin.
Object.defineProperty(module.exports, 'subRootsOf', { value: subRootsOf });
