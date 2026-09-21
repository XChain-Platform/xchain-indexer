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
 * XChain Indexer - Database class part: ledger checks
 *
 * Ledger and token predicates the action handlers call (distribution, lists, balances,
 * allow and block lists, markets) and the hub push retry queue helpers.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

// The list-edit resolution flag day (keyed '<COIN>:<network>', so the coin goes with
// the height) and token-policy inheritance are registry rows read by literal key (W5).
// Token-policy inheritance: the flag day at which a LIST type-2 item, and the address-sleep
// read that shares its validator, are judged against EVERY supported coin instead of only
// this chain's. One issuer list has to be able to hold BTC, LTC and DOGE addresses, because
// the policy on the origin row is the policy every bridged copy inherits.
const gateRegistry = require('../../consensus/gate_registry');
const LIST_EDIT_RESOLUTION_KEY = 'list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION';
const TOKEN_POLICY_INHERITANCE_KEY = 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION';

module.exports = {

    // Determine if an ticker is distributed to users (held by more than owner)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async isDistributed(tick, block_index, action_index, tokenInfo=null){
        let info    = tokenInfo ?? await this.getTokenInfo(tick, block_index, action_index);
        let holders = (info) ? await this.getHolders(tick, block_index, action_index) : [];
        // More than one holder
        if(Object.keys(holders).length>1)
            return true;
        // Holder that is not OWNER
        for(let address in holders)
            if(address!=info['OWNER'])
                return true;
        return false;
    },

    // Validate if a list is a valid type
    // @param {action_index}  integer  ACTION_INDEX to a list
    // @param {type}          string   List Type (1=TICK, 2=ADDRESS)
    async isValidList(action_index, type){
        let list_type = await this.getListType(action_index);
        if(list_type==type)
            return true;
        return false;
    },

    // Whether the LIST edit-chain resolution is in effect at `block_index`
    // on this indexer's chain. Wrapper so action handlers gate on the same
    // predicate getList uses without re-deriving network/coin.
    // @param {block_index}  integer  block being processed
    isListEditResolutionActive(block_index){
        return gateRegistry.activeAt(LIST_EDIT_RESOLUTION_KEY, this.config['NETWORK'], this.config['COIN'], block_index, null);
    },

    // Create / Update record in `credits` table
    async createCredit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('credits', action_index, tick, amount, address);
    },

    // Create / Update record in `debits` table
    async createDebit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('debits', action_index, tick, amount, address);
    },

    // Create / Update record in `escrows` table
    async createEscrow(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('escrows', action_index, tick, amount, address);
    },

    // Get address balances using credits/debits table data
    async getAddressBalances(address, tick, block_index, action_index){
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let [credits, debits] = await Promise.all([
            this.getAddressCreditDebit('credits', address_id, null, block_index, action_index),
            this.getAddressCreditDebit('debits',  address_id, null, block_index, action_index)
        ]);
        let balances = {}; // Object to store tick_id/balance
        // Build out balances (credits - debits).
        // Compute at full (18-decimal) precision rather than the token's own
        // precision: rounding here per-address causes sum-of-rounded-balances
        // to drift from rounded-sum-of-ledger when a token's decimals are too
        // low to represent the underlying ledger values (e.g. fractional VM
        // gas fees against a tick issued with decimals=0). The sanityCheck's
        // DECIMAL(60, decimals) cast rounds the aggregate sum the same way on
        // both sides, so as long as per-address balances stay exact, both
        // paths agree.
        for(let tick_id in credits){
            let credit  = credits[tick_id];
            let debit   = (!this.util.isNull(debits[tick_id])) ? debits[tick_id] : 0;
            let balance = null;
            try {
                balance = this.util.bcsub(credit, debit, 18);
            } catch(err){
                balance = this.util.bcadd(0, 0, 18);
            }
            // Pass forward any numeric values (including 0 balance)
            if(this.util.isNumeric(balance))
                balances[tick_id] = balance;
        }
        return balances;
    },

    // Handle getting token info (supply, price, etc) and updating the `tokens` table
    async updateTokenInfo(tick){
        // createTicker and getTokenInfo are independent; run them concurrently.
        // tick_id is unused here - createToken calls createTicker internally.
        const [, data] = await Promise.all([this.createTicker(tick), this.getTokenInfo(tick)]);
        // Update the record in `tokens` table
        if(data)
            await this.createToken(data);
    },

    // Convenience wrapper - true if this tick's ownership is currently escrowed.
    async isOwnershipEscrowed(tick){
        return (await this.getTokenEscrow(tick)) !== null;
    },

    // Validate if a ticker exists before before a given action_index
    async validTickerBeforeTxIndex(tick, action_index){
        let issue_index = await this.getFirstIssueActionIndex(tick);
        if(issue_index !== false && issue_index < action_index)
            return true;
        return false;
    },

    // Is `address` well-formed for THIS chain, or - at/above
    // TOKEN_POLICY_INHERITANCE_ACTIVATION - for ANY coin the platform supports on this
    // network? A loop over the existing coin-and-network-aware validator, never a new
    // validator, so the address rules stay in one place.
    //
    // WHY THE WIDENING EXISTS: a bridged copy inherits ONE list from its origin row, so that
    // list has to be able to name holders on every chain a copy lives on. Below the flag the
    // one-argument call resolves to this chain's coin and a foreign-format address is simply
    // not an address here, which is the historical rule and stays byte-identical on replay.
    //
    // Prefix sharing makes some strings valid on more than one chain (regtest BTC, LTC and
    // DOGE all use p2pkh 0x6f / p2sh 0xc4). That is harmless in both consumers: membership
    // matching is exact string equality, so a string valid on two chains is simply that
    // string on both.
    // @param {address}      string   address to judge
    // @param {block_index}  integer  block being processed; gates the widening
    isAnyCoinAddress(address, block_index){
        if(this.util.isCryptoAddress(address))
            return true;
        if(!gateRegistry.activeAt(TOKEN_POLICY_INHERITANCE_KEY, this.config['NETWORK'], null, block_index, null))
            return false;
        for(let coin of (this.config['COINS'] || []))
            if(this.util.isCryptoAddress(address, coin, this.config['NETWORK']))
                return true;
        return false;
    },

    // Check if an address is allowed to perform an action
    // Validations: 
    // - Ticker  is allowed to perform actions (sleep)
    // - Address is allowed to perform actions (sleep)
    // - Address is allowed to hold tick (allow/block lists)
    async isActionAllowed(address, tick, block_index){
        let allow = true;
        // Validate block_index is good
        if(allow && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            // Validate TICK and ADDRESS sleep status in parallel
            const [tickSleeping, addressSleeping] = await Promise.all([
                (!this.util.isNull(tick))     ? this.isTickSleeping(tick, block_index)       : Promise.resolve(false),
                (!this.util.isNull(address))  ? this.isAddressSleeping(address, block_index) : Promise.resolve(false)
            ]);
            if(tickSleeping || addressSleeping)
                allow = false;
        }
        // Validate address against any tick allow/block lists
        if(allow && !this.util.isNull(address) && !this.util.isNull(tick)){
            let info = await this.getTokenInfo(tick, block_index);
            // Fetch allow/block lists in parallel if both exist
            const hasAllowList = info && !this.util.isNull(info['ALLOW_LIST']) && this.util.isNumeric(info['ALLOW_LIST']);
            const hasBlockList = info && !this.util.isNull(info['BLOCK_LIST']) && this.util.isNumeric(info['BLOCK_LIST']);
            const [allowList, blockList] = await Promise.all([
                hasAllowList ? this.getList(info['ALLOW_LIST'], block_index) : Promise.resolve(null),
                hasBlockList ? this.getList(info['BLOCK_LIST'], block_index) : Promise.resolve(null)
            ]);
            // False if we have an ALLOW_LIST and address is NOT on it
            if(allow && allowList && !allowList.includes(address))
                allow = false;
            // False if we have a BLOCK_LIST and address IS on it
            if(allow && blockList && blockList.includes(address))
                allow = false;
        }
        return allow;
    },

    // Get total amount of credit or debit records for a given address, ticker, and action
    async getActionCreditDebitAmount(table, action, tick, address, action_index){
        let total   = 0;
        let tick_id = await this.createTicker(tick);
        let addr_id = await this.createAddress(address);
        let data    = await this.getAddressCreditDebit(table, addr_id, action, null, action_index);
        if(data[tick_id])
            total = data[tick_id];
        return total;
    },

    // Get market_id for given ticker ids
    async getMarketId(tick1_id, tick2_id){
        let row = await this.getMarketRow(tick1_id, tick2_id);
        return (row) ? row.id : null;
    },

    // Handle finding and updating markets
    async updateMarkets(markets, block_index){
        let block_time = await this.getBlockTime(block_index);
        await Promise.all(markets.map(async (pair) => {
            let market_id = await this.getMarketId(pair.tick1_id, pair.tick2_id);
            if(market_id){
                let data = await this.getMarketInfo(market_id, block_time);
                await this.updateMarketInfo(data);
            }
        }));
    },

    // Create record in `delegations` table with 'revoked' status
    async createRevokeDelegation(data){
        // Set status to reflect revocation intent, then create as normal delegation record
        await this.createDelegation(data);
    },

    /*
     * Hub push retry queue (`pending_hub_pushes`)
     *
     * Durable backing for best-effort hub pushes (PRICE v0 round / PRICE v1
     * oracle price). When a live push fails, the payload is parked here and the
     * HubPushQueue poller drains it later with exponential backoff.
     *
     * These methods deliberately bypass doQuery()/getConnection(): the poller
     * runs concurrently with block processing on this same `indexerDb` instance,
     * and getConnection() returns the open block's `transactionConnection` while
     * a block is being processed. Routing queue writes through it would attach
     * operational queue I/O to the block's ACID transaction (committed/rolled
     * back with the block) and risk two statements sharing one physical
     * connection. poolQuery() always draws an independent pooled connection.
     */

    // Run a query on a fresh pooled connection, isolated from any in-progress
    // block transaction. Always releases the connection.
    async poolQuery(query, args){
        let conn = await this.pool.getConnection();
        try {
            return await conn.query(query, args);
        } finally {
            await conn.release();
        }
    },

    // API-path view of this DB instance: same methods, but every doQuery()
    // draws an independent pooled connection (poolQuery) instead of routing
    // through getConnection(), which returns the open block's
    // transactionConnection while a block is processing. Any federation RPC
    // handler that WRITES must use this view. There is none today (the last one,
    // pushvalidatorrewards, was retired), and the rule is what made that safe: a
    // write landing mid-block would otherwise join the block's ACID transaction
    // and be rolled back on a reorg/throw AFTER the API already acked it (the
    // caller never retries), and its statements would share the block's physical
    // connection with commitTransaction()'s release. The view also sees only
    // COMMITTED state, so stake-source resolution never reads rows the block
    // may still roll back. Do NOT use it for anything that opens its own
    // transaction (e.g. the dry-run path): the override bypasses
    // transactionConnection entirely.
    apiView(){
        if(!this._apiView){
            this._apiView = Object.create(this);
            this._apiView.doQuery = (query, args) => this.poolQuery(query, args);
            // doQueryStrict must also bypass transactionConnection. poolQuery already throws on a
            // query error (no swallow), so it satisfies the strict contract. Without this override,
            // a method that internally calls doQueryStrict (e.g. createReorg) would still adopt an
            // open foreign transaction when invoked on the view - defeating the reorg-path isolation
            // that routes createReorg / the rollback read-phase through this view (REORG-1).
            this._apiView.doQueryStrict = (query, args) => this.poolQuery(query, args);
            // Own both time memos so an API read cannot refill or evict the block loop's
            // caches while a reorg clears them. Without these properties the view inherits
            // the instance's single-entry memos by reference through Object.create.
            this._apiView._blockTimeCache = { block_index: null, block_time: null };
            this._apiView._protocolTimeCache = { block_index: null, block_time: null };
            // clearBlockTimeCache() replaces the parent's memo objects and never reaches
            // the view's own, so a rolled-back height would keep serving the orphaned
            // chain's time to API reads. Each time read first notices the parent's memo
            // was replaced since the last sync and drops the view's copies. Done at read
            // time, not by aliasing, so a read already in flight still fills its own memo.
            const parent = this;
            const view = this._apiView;
            let seenBlock = parent._blockTimeCache;
            let seenProtocol = parent._protocolTimeCache;
            const syncWithParent = () => {
                if(parent._blockTimeCache === seenBlock && parent._protocolTimeCache === seenProtocol) return;
                seenBlock = parent._blockTimeCache;
                seenProtocol = parent._protocolTimeCache;
                view._blockTimeCache = { block_index: null, block_time: null };
                view._protocolTimeCache = { block_index: null, block_time: null };
            };
            for(const method of ['getRawBlockTime', 'getBlockTime']){
                const inherited = parent[method];
                if(typeof inherited !== 'function') continue;
                view[method] = function(...args){
                    syncWithParent();
                    return inherited.apply(this, args);
                };
            }
        }
        return this._apiView;
    },

    // Stage a hub push (already durably written via enqueueHubPushTx inside the open block
    // transaction) for an immediate live delivery attempt AFTER the block commits. XChainIndexer
    // installs a fresh _stagedHubPushes array at the start of each block and drains it post-commit
    // (mirroring rollback.js's post-commit retraction delivery). A rollback simply never drains the
    // array (it is replaced at the next block start), and the durable rows were rolled back with the
    // transaction, so nothing phantom survives. Inert (no-op) when no array is installed.
    stageHubPush(entry){
        if(Array.isArray(this._stagedHubPushes)) this._stagedHubPushes.push(entry);
    },

    // Return the staged hub pushes for this block and clear the buffer, so a post-commit drain
    // consumes each entry exactly once. Returns [] when nothing was staged.
    takeStagedHubPushes(){
        let staged = Array.isArray(this._stagedHubPushes) ? this._stagedHubPushes : [];
        this._stagedHubPushes = Array.isArray(this._stagedHubPushes) ? [] : this._stagedHubPushes;
        return staged;
    },

};
