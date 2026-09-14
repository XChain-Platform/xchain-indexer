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
 * XChain Indexer - Database mixin: actions
 * 
 * The queries over the actions table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const { buildStateHashData, ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('../stateHash');
const { canonicalizeHashAddress } = require('../consensus/protocolAddressRoles');
const stateKeyCollation = require('../state_key_collation_activation');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../protocol/constants.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { BLOCK_HASH_VERSION } = require('./shared.js');
// The actions mixin is cut into parts by behaviour under actions/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
// getBlockHashes stays here whole: both blockhash conformance guards read its SQL out of
// this file's text, and xchain-sync's copy reads this exact path.
const actionIndex = require('./actions/action_index.js');

module.exports = {

    // Get block hashes using credits/debits/actions table data and previous hash
    async getBlockHashes(block_index){
        let query   = null;
        // Placeholders for actions data
        let actions = [];
        // Placeholer for ledger data (credits + debits + escrows)
        let ledger  = {
            credits:  [],
            debits:   [],
            escrows:  []
        };
        let info    = [];
        let hashes  = [];
        // CONSENSUS: every query below scopes the block by the ACTION's own block_index
        // (a.block_index), NOT by joining transactions on tx_index. Protocol-generated actions
        // (ORDER_MATCH / SWAP_MATCH / *_EXPIRE, etc.) carry tx_index = NULL with no transactions
        // row, so the old `INNER JOIN transactions ... WHERE t.block_index` silently dropped them
        // and their ledger effects (match settlements, expiry refunds) from the hash. actions.block_index
        // is set for EVERY row (createActionIndex) and equals the tx's block for tx-bearing actions,
        // so this is purely additive: tx-only blocks hash identically, blocks with synthetic actions
        // now cover them. ORDER BY action_index already gives those rows a deterministic position.
        // (BLOCK_HASH_VERSION unchanged: same preimage structure, more rows; everything re-bases
        // atomically pre-launch. xchain-sync/src/client/block_hasher.js is the byte-for-byte conformance pair.)
        // Get data from credits table
        // These rows feed the consensus ledger hash. We hash the RESOLVED address/ticker
        // strings (LEFT JOIN through the lookup tables), never the raw address_id/tick_id -
        // those are local AUTO_INCREMENT ids that diverge across nodes after a reorg (see
        // BLOCK_HASH_VERSION). LEFT JOIN preserves rows whose address_id/tick_id is NULL
        // (native-coin movements) as a NULL string, matching every node.
        // credits/debits/escrows have no primary key: ORDER BY action_index alone leaves the
        // order of an action's multiple rows (e.g. an ISSUE's fee credit + mint credit)
        // engine-unspecified, which forks the hash across nodes. Sort on every selected
        // (resolved) column, pinning a BINARY collation so the order is independent of each
        // node's default collation (index_addresses is utf8_general_ci = case/accent-folding).
        query = `SELECT
                    c.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    c.amount
                FROM
                    credits c
                    INNER JOIN actions        a  ON (a.action_index=c.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=c.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=c.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    c.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, c.amount ASC`;
        ledger.credits = await this.doQuery(query, [block_index]);
        // Get data from debits table
        query = `SELECT
                    d.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    d.amount
                FROM
                    debits d
                    INNER JOIN actions        a  ON (a.action_index=d.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=d.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    d.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC`;
        ledger.debits = await this.doQuery(query, [block_index]);
        // Get data from escrows table
        query = `SELECT
                    e.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    e.amount
                FROM
                    escrows e
                    INNER JOIN actions        a  ON (a.action_index=e.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=e.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=e.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    e.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, e.amount ASC`;
        ledger.escrows = await this.doQuery(query, [block_index]);
        // CONSENSUS: canonicalize protocol special addresses (BURN/GAS/DONATE/REWARD)
        // to their chain-independent role token in the hash preimage. A per-chain
        // special address (e.g. an issuance fee credited to DONATE1) otherwise leaks
        // the chain's address encoding into the consensus hash, forking the hash chain
        // across BTC/LTC/DOGE for identical actions. Done here so BOTH the flat ledger
        // hash below AND the block_merkle_root (which reuses these stashed rows) see the
        // same canonical strings; balances still track the real address (rows are not
        // mutated in the DB, only this gathered copy used for hashing). See
        // protocolAddressRoles.js; xchain-sync/src/client/block_hasher.js mirrors this byte-for-byte.
        for (const row of ledger.credits) row.address = canonicalizeHashAddress(row.address);
        for (const row of ledger.debits)  row.address = canonicalizeHashAddress(row.address);
        for (const row of ledger.escrows) row.address = canonicalizeHashAddress(row.address);
        // Get data from actions table
        // Hash the RESOLVED action-type string (e.g. 'SEND'), not the raw action_id - that
        // is an index_actions AUTO_INCREMENT id assigned on first reference (createAction)
        // and so diverges across nodes after a reorg, exactly like address_id/tick_id.
        query = `SELECT
                    a.action_index,
                    a.tx_index,
                    ia.action AS action
                FROM
                    actions a                    LEFT  JOIN index_actions ia ON (ia.id=a.action_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    a.action_index ASC`;
        actions = await this.doQuery(query, [block_index]);
        // Contract hash data
        let contracts_data = {
            contracts:   [],
            state:       [],
            executions:  [],
            emissions:   [],
            deposits:    [],
            withdrawals: []
        };
        // New deployments. Resolve source_id -> address and status_id -> status string
        // (id-independent, see BLOCK_HASH_VERSION). action_index is unique on contracts so
        // ORDER BY action_index alone is a total order.
        // NOTE: `deploy_chunks` is intentionally NOT a checkpoint-hash input. A chunked
        // DEPLOY's assembled `code` (every consumed chunk's bytes, in pinned order) is
        // sha256-bound into `c.code_hash` at assembly time (actions/deploy.js), so the
        // chunk bytes are already covered here via code_hash. The table itself holds only
        // un-consumed/orphan chunk metadata, derived identically on same-version nodes.
        query = `SELECT c.action_index, a1.address AS source_address, c.code_hash, s1.status AS status
                 FROM contracts c
                 INNER JOIN actions a ON (a.action_index=c.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=c.source_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=c.status_id)
                 WHERE a.block_index=?
                 ORDER BY c.action_index ASC`;
        contracts_data.contracts = await this.doQuery(query, [block_index]);
        // Contract state (latest value per key written in this block).
        // state_key collation is flag-day gated (state_key_collation_activation.js):
        // contract_state is utf8_general_ci (case/accent-folding), so the legacy
        // GROUP BY/ORDER BY treat distinct keys like "Key"/"key" as EQUAL - the
        // folding GROUP BY collapses them to one MAX(id) row, silently dropping the
        // other key's value from the contract_hash preimage. At/after the activation
        // height state_key is pinned COLLATE utf8_bin (the same hazard the
        // address/tick sorts above already pin against); below it the folding form
        // is kept so historical block hashes replay byte-identically.
        // xchain-sync/src/client/block_hasher.js mirrors this gate byte-for-byte.
        let stateKeyBin = stateKeyCollation.isStateKeyBinCollationActive(
            block_index, this.config['NETWORK'], this.config['COIN']);
        let stateKeyCollate = stateKeyBin ? ' COLLATE utf8_bin' : '';
        query = `SELECT cs.contract_index, cs.state_key, cs.state_value
                 FROM contract_state cs
                 INNER JOIN (
                     SELECT MAX(id) as max_id
                     FROM contract_state
                     WHERE block_index=?
                     GROUP BY contract_index, state_key` + stateKeyCollate + `
                 ) latest ON cs.id = latest.max_id
                 ORDER BY cs.contract_index ASC, cs.state_key` + stateKeyCollate + ` ASC`;
        contracts_data.state = await this.doQuery(query, [block_index]);
        // Executions. Resolve caller_id -> address and status_id -> status string. contract_index
        // is the deploy's action_index (deterministic, not a surrogate id). action_index is unique.
        query = `SELECT ce.action_index, ce.contract_index, a1.address AS caller_address, ce.gas_used, s1.status AS status, ce.emitted_count
                 FROM contract_executions ce
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=ce.caller_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=ce.status_id)
                 WHERE a.block_index=?
                 ORDER BY ce.action_index ASC`;
        contracts_data.executions = await this.doQuery(query, [block_index]);
        // Emissions (join through executions to get block scope)
        query = `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
                 FROM contract_emissions em
                 INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 WHERE a.block_index=?
                 ORDER BY em.execution_index ASC, em.position ASC`;
        contracts_data.emissions = await this.doQuery(query, [block_index]);
        // Deposits. Resolve source_id -> address, tick_id -> tick, status_id -> status. The
        // secondary sort keys (kept from the tie-order fix) now use the resolved strings with a
        // pinned BINARY collation so the order is id- and collation-independent across nodes.
        query = `SELECT d.action_index, d.contract_index, a1.address AS source_address, t1.tick AS tick, d.amount, s1.status AS status
                 FROM deposits d
                 INNER JOIN actions a ON (a.action_index=d.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=d.source_id)
                 LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=d.status_id)
                 WHERE a.block_index=?
                 ORDER BY d.action_index ASC, d.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC, s1.status COLLATE utf8_bin ASC`;
        contracts_data.deposits = await this.doQuery(query, [block_index]);
        // Withdrawals. Same resolution + tie-order treatment as deposits.
        query = `SELECT w.action_index, w.contract_index, a1.address AS source_address, t1.tick AS tick, w.amount, s1.status AS status
                 FROM withdrawals w
                 INNER JOIN actions a ON (a.action_index=w.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=w.source_id)
                 LEFT  JOIN index_tickers   t1 ON (t1.id=w.tick_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=w.status_id)
                 WHERE a.block_index=?
                 ORDER BY w.action_index ASC, w.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, w.amount ASC, s1.status COLLATE utf8_bin ASC`;
        contracts_data.withdrawals = await this.doQuery(query, [block_index]);
        // Stash the gathered canonical rows so the light-client block_merkle_root
        // (stateCommitment.js, SPV spec §5) can build leaves over the EXACT same
        // rows + ORDER BY as these flat hashes, without re-querying or duplicating
        // the consensus SQL. createBlock() calls getBlockHashes() once per block
        // just before the state-commitment hook runs, so this stash is warm.
        this._lastGatheredBlockRows = { block_index: block_index, ledger: ledger, actions: actions, contracts: contracts_data };
        // Subtract one block from current block
        let prev_block_index = block_index -1;
        // Get hashes from the previous block to include in this blocks hash
        query = `SELECT
                t1.hash as ledger,
                t2.hash as actions,
                t3.hash as contracts
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
                LEFT JOIN index_transactions t3 ON (t3.id=b.contract_hash_id)
            WHERE
                b.block_index=?`;
        let results = await this.doQuery(query, [prev_block_index]);
        if(results.length >0){
            hashes['ledger']    = results[0].ledger;
            hashes['actions']   = results[0].actions;
            hashes['contracts'] = results[0].contracts;
        }
        // Define list of data to hash
        let tables = ['ledger','actions','contracts'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='ledger')    data = ledger;
            if(table=='actions')   data = actions;
            if(table=='contracts') data = contracts_data;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            // Fold the consensus hash-scheme version into the preimage so a future scheme
            // change can never collide with or be compared as equal to the current scheme.
            data['hash_version']  = BLOCK_HASH_VERSION;
            info[table] = [];
            info[table]['hash'] = this.util.getDataHash(data);
        });
        // Fourth, NON-consensus integrity hash over the in-place mutations + backdated
        // refund credits the three hashes above structurally cannot cover (rows created in
        // an EARLIER block, mutated in place - replicated via xchain-sync's updated_rows /
        // cooldownCredits channels; see stateHash.js). Additive: NOT chained, NOT folded into
        // ledger/actions/contract, NOT in BLOCK_HASH_VERSION, NOT in getStoredBlockHashes /
        // the hub-signed checkpoint. Its sole consumer is xchain-sync's apply-time recompute,
        // which HALTS a follower that silently failed to apply one of those mutations.
        // ACTIVATION_DELAY_BLOCKS lives nested under config['STAKING'] (calibrated per chain:
        // BTC 6 / LTC 24 / DOGE 60); the top-level key is unset. Resolve it nested-first exactly
        // as every other reader does (delegate.js:128, stake.js, unstake.js, rollback.js). The
        // old top-level read returned undefined, so delay became null and buildStateHashData
        // skipped the entire deactivation_block class on the SOURCE, while the follower (ClientSync)
        // recomputes with the real per-chain delay and INCLUDES it: a guaranteed state-hash
        // divergence HALT on the first deactivation-bearing block, and the feature's primary row
        // class never hashed.
        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        let stateData = await buildStateHashData(this, block_index, {
            activationDelay: activationDelay,
            gasTick:         this.config['GAS'],
            // network gates the additive index-map class (id-determinism P4); coin extends
            // the lookup to the per-chain '<COIN>:<network>' keys the mid-chain-armed
            // classes (poll_finalize / token_supply) use. The sync follower's recompute
            // (BlockHasher.computeStateHash) MUST pass the same pair or the conformance
            // hash diverges at the activation heights.
            network:         this.config['NETWORK'],
            coin:            this.config['COIN']
        });
        info['state'] = [];
        info['state']['hash'] = this.util.getDataHash(stateData);
        return info;
    },

    ...actionIndex,

};
