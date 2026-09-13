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
 * XChain Indexer - Database mixin: credits
 * 
 * The queries over the credits table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const ledgerPrecision = require('../ledger_amount_precision_activation');
// getbridgeescrowproof (base spec section 12, D2/D70): the proof-producing read shares
// the SAME key/leaf derivation and the SAME persistent, content-addressed SMT the block
// path commits, never a rebuilt in-memory tree, so a proof this method hands out can only
// ever match what was actually committed.
const bridgeMerkle = require('../merkle.js');
const bridgeStateCommitment = require('../stateCommitment.js');
// state_root_version is a DERIVED-per-height quantity (api.js getblockhashes is the ONLY
// place it is MINTED), never the static merkle.STATE_ROOT_VERSION constant: a static
// comparison refuses every checkpoint cut once a sub-tree slot arms. getBridgeEscrowProof
// re-derives it here as a guard against handing out an envelope built from a stale or
// mis-migrated state_checkpoints row.
const bridgeStateSubtree = require('../state_subtree_activation.js');

module.exports = {

    // Early-decide watermark helpers. See the _pollTallyWatermark comment in the
    // constructor and processVoteFinalizations step 2. The fingerprint is the highest
    // action_index present in each of the poll's three tally-input tables (votes for the poll,
    // delegations for the tick, and the tick's credits/debits ledger). All three are append-only
    // during forward processing, so a strictly-higher MAX means a new input row landed; an
    // unchanged tuple proves no input changed and the tally is byte-identical. action_index (not
    // block_index) is used so the fingerprint moves even for multiple input rows within one block.
    async getPollTallyInputWatermark(pollIndex, tick_id){
        let rows = await this.doQuery(
            `SELECT
                (SELECT COALESCE(MAX(action_index),0) FROM votes WHERE poll_index=?)            AS v,
                (SELECT COALESCE(MAX(action_index),0) FROM vote_delegations WHERE tick_id=?)     AS d,
                (SELECT COALESCE(MAX(action_index),0) FROM (
                    SELECT action_index FROM credits WHERE tick_id=?
                    UNION ALL
                    SELECT action_index FROM debits  WHERE tick_id=?
                 ) led)                                                                          AS l`,
            [pollIndex, tick_id, tick_id, tick_id]);
        let r = (rows && rows[0]) ? rows[0] : {};
        return String(r.v || 0) + ':' + String(r.d || 0) + ':' + String(r.l || 0);
    },

    // Get token supply from credits/debits table (credits - debits + escrows = supply)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenSupply(tick, block_index, action_index){
        let credits = 0;
        let debits  = 0;
        let escrows = 0;
        let supply  = 0;
        let sql     = '',
            query   = '',
            args    = [],
            results = null,
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // Scope by the ACTION's own block_index (a.block_index), NOT by joining transactions
        // on tx_index. Protocol-generated / synthetic actions (ORDER_MATCH, *_EXPIRE, VOTE v2,
        // the UNSTAKE v2 cooldown completion, etc.) carry tx_index = NULL with no transactions
        // row, so the old `INNER JOIN transactions` silently dropped their ledger effects from
        // this supply sum. That stayed invisible only while every synthetic effect was net-zero
        // on supply (matched credit+debit / escrow release); the UNSTAKE v2 completion is the
        // first synthetic NET-MINT credit, so it exposed the gap as a balances>ledger SanityError.
        // Mirrors the identical fix in getBlockHashes. actions.block_index is set for every row.
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND a.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Each component is summed EXACTLY (18 dp) and the combination is rounded
        // ONCE at the tick's own scale. Rounding each component first
        // and then combining is not the same number: round(C) - round(D) + round(E)
        // can differ from round(C - D + E) by a whole unit when the ledger carries
        // amounts finer than the tick (fees at 8 dp against a 0-decimal gas tick),
        // and the balances-side projection in sanityCheck rounds only once, so a
        // per-component rounding here forks the two sides into a SanityError.
        // On rows written before the exact-ledger flag-day every amount is already
        // an exact multiple of 10^-decimals, so this is value-identical to the old
        // per-row SUM(CAST(m.amount AS DECIMAL(60,decimals))).
        let sumExpr = ledgerPrecision.exactSumSql('m.amount');
        // Get Credits
        query = `SELECT
                    ` + sumExpr + ` as credits
                FROM
                    credits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].credits))
            credits = results[0].credits;
        // Get Debits
        query = `SELECT
                    ` + sumExpr + ` as debits
                FROM
                    debits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].debits))
            debits = results[0].debits;
        // Get Escrows
        query = `SELECT
                    ` + sumExpr + ` as escrows
                FROM
                    escrows m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].escrows))
            escrows = results[0].escrows;
        // Determine total supply ((credits - debits) + escrows), rounded once.
        let exact = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        supply = this.util.bcadd(this.util.bcsub(credits, debits, exact), escrows, decimals);
        return supply;
    },

    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    // TODO(j-dog): Can optimize this function to allow getting list of holders from balances table instead of credits/debits
    async getHolders(tick, block_index, action_index){
        let holders = {};
        let sql     = '',
            query   = '',
            results = null,
            args    = [],
            tick_id = null;
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // NOTE: the tick's decimal precision is no longer read here. Holder
        // balances are netted at the exact ledger scale (below), so the lookup
        // was a wasted round-trip per call.
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND a1.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Per-holder credits and debits are summed EXACTLY (18 dp) and netted at
        // that scale, matching getAddressBalances / getNetBalance. The
        // former per-row cast to the tick's scale made sum-of-rounded-holdings
        // drift from the rounded ledger sum as soon as any row was finer than the
        // tick; on pre-flag-day rows (already on the tick's grid) it is identical.
        let holderSumExpr = ledgerPrecision.exactSumSql('m.amount');
        let exact         = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        // Get Credits
        query = `SELECT
                    ` + holderSumExpr + ` as credits,
                    a2.address
                FROM 
                    credits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0)
            for(let row of results)
                holders[row.address] = row.credits;
        // Get Debits
        query = `SELECT
                    ` + holderSumExpr + ` as debits,
                    a2.address
                FROM 
                    debits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                let balance = this.util.bcsub(holders[row.address], row.debits, exact);
                if(this.util.bcgt(balance, 0))
                    holders[row.address] = balance;
                else
                   delete holders[row.address];
            }
        }
        // Sort holders list from biggest to smallest. Equal balances fall back to a
        // lexicographic address tiebreak so the iteration order is deterministic across
        // nodes - the GROUP BY queries above carry no ORDER BY, so equal-balance holders
        // would otherwise iterate in engine-arbitrary order, forking the DIVIDEND/AIRDROP/
        // CALLBACK credit INSERT sequence (and therefore the ledger hash) across validators.
        holders = Object.fromEntries(Object.entries(holders).sort(([addrA, a], [addrB, b]) => {
            if(this.util.bcgt(b, a)) return  1;
            if(this.util.bclt(b, a)) return -1;
            return addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
        }));
        return holders;
    },

    // Compute a poll's tally deterministically (Phase 1 lazy tally; the same logic
    // the system-injected VOTE v2 will freeze on-chain in Phase 2). Weight is the
    // voter's balance at the measure block (default = the poll's close block);
    // callers may pass the current tip for a provisional standing on an open poll.
    // Enforces the close-time backing rule (a voter must still hold the token at
    // the measure block) and the dust floor on participation counting.
    // Time-weighted average balance of every holder over [startBlock, endBlock],
    // for the time_weighted VOTE weight mode (Section 12.2). Resists
    // flash-acquisition voting: weight reflects sustained holding, not a close
    // snapshot. Derived from the credits/debits ledger (each event joined to its
    // action's block), NOT an O(blocks) scan: balance at startBlock + the signed
    // window events reconstruct the trajectory; each segment contributes
    // balance*blocks_held, summed and divided by the window length. All mathjs
    // fixed-precision; same-block events have zero-length segments so intra-block
    // ordering never affects the result (deterministic). Returns {address: avg}.
    async getTimeWeightedBalances(tick, startBlock, endBlock){
        startBlock = Number(startBlock);
        endBlock   = Number(endBlock);
        let windowLen = endBlock - startBlock;
        let startBal  = await this.getHolders(tick, startBlock, null);
        let tick_id   = await this.createTicker(tick);
        // Signed balance-change events in (startBlock, endBlock], oldest first.
        let rows = await this.doQuery(
            `SELECT ia.address AS address, ac.block_index AS block_index, c.amount AS amount, 1 AS sign
               FROM credits c
               INNER JOIN actions ac        ON ac.action_index = c.action_index
               INNER JOIN index_addresses ia ON ia.id = c.address_id
              WHERE c.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
             UNION ALL
             SELECT ia.address AS address, ac.block_index AS block_index, d.amount AS amount, -1 AS sign
               FROM debits d
               INNER JOIN actions ac        ON ac.action_index = d.action_index
               INNER JOIN index_addresses ia ON ia.id = d.address_id
              WHERE d.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
              ORDER BY block_index ASC`,
            [tick_id, startBlock, endBlock, tick_id, startBlock, endBlock]);
        let evByAddr = {};
        for(let r of rows){
            if(this.util.isNull(evByAddr[r.address])) evByAddr[r.address] = [];
            let delta = (Number(r.sign) < 0) ? this.util.bcmul(String(r.amount), '-1', 18) : String(r.amount);
            evByAddr[r.address].push({ block: Number(r.block_index), delta: delta });
        }
        let result = {};
        let addrs  = new Set([...Object.keys(startBal), ...Object.keys(evByAddr)]);
        for(let addr of addrs){
            let bal = this.util.isNull(startBal[addr]) ? '0' : String(startBal[addr]);
            // Degenerate window (close == creation): no integral, average is the
            // start balance (avoids divide-by-zero; a poll closing at its own
            // creation block can only happen via an immediate early-decide).
            if(windowLen <= 0){ result[addr] = bal; continue; }
            let prevBlock = startBlock;
            let integral  = '0';
            for(let ev of (evByAddr[addr] || [])){
                let segLen = ev.block - prevBlock;
                if(segLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(segLen), 18), 18);
                bal = this.util.bcadd(bal, ev.delta, 18);
                prevBlock = ev.block;
            }
            let tailLen = endBlock - prevBlock;
            if(tailLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(tailLen), 18), 18);
            result[addr] = this.util.bcdiv(integral, String(windowLen), 18);
        }
        return result;
    },

    // Chain-state half of getbridgeinvariant (getbridgebalances RPC, base spec section 13;
    // CrossChainBridgeEngine._readBridgeBalances is the caller): the tick's supply on THIS
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
    // escrow is keyed by the BARE coin (never the BRIDGE_ prefix): the hub's _escrowFor
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
     * @param {string} address     - the escrow address being proven
     * @param {string} tick        - the native tick (never the rooted form)
     * @param {number} block_index - the height to prove the balance AT
     * @returns {Promise<Object|null>} the envelope, or null when it cannot be produced
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

        // state_checkpoints is hub-mirrored, so it lives wherever the mirror writes: the
        // hub-DB copy on a distributed deployment (where the ledger database's copy of the
        // table exists but stays empty) and this database only on a single-host one. The
        // ledger connection is the wrong place to ask on every standing indexer, and an
        // origin indexer asked there can never produce a proof, which stalls every in leg
        // on the destination's proof barrier. Same handle the proof client reads through.
        let cpRows = await this._mirrorDb().doQueryStrict(
            `SELECT checkpoint_seq, snapshot_block, state_root, state_root_version
             FROM state_checkpoints WHERE chain=? AND network=? AND block_index=? LIMIT 1`,
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

        let balRows = await this.doQueryStrict(
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
        let balance = this.util.bcstr(this.util.bcsub(cr, dr, 18));

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

        let subRoots = {
            balances_root: rootRow.balances_root,
            stakes_root:   rootRow.stakes_root
        };
        if(!this.util.isNull(rootRow.contract_state_root))
            subRoots.contract_state_root = rootRow.contract_state_root;

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
