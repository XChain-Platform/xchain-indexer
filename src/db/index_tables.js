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
 * XChain Indexer - Database mixin: index_tables
 * 
 * The queries over the index_tables table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { CANONICAL_CARET_ID } = require('./shared.js');

const { getLogger } = require('../observability/index.js');
module.exports = {

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        // Genesis intern cache: the same synthetic tx hash is resolved several times per
        // action (createTxIndex/createActionIndex/mappings); serve non-null hits from memory.
        if(this._internCache !== null){
            let hit = this._internCache.tx.get(hash);
            if(hit !== undefined)
                return hit;
        }
        let id    = null;
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        let results = await this.doQuery(query, [hash]);
        if(results.length > 0)
            id = Number(results[0].id);
        if(id !== null && this._internCache !== null)
            this._internCache.tx.set(hash, id);
        return id;
    },

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hash and return NULL
        if(this.util.isNull(hash))
            return null;
        // Truncate to 250 characters
        hash = String(hash).substring(0,250);
        let id = await this.getTransactionId(hash);
        // Create transaction if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: a
            // concurrent insert of the same hash is skipped (no duplicate-key throw),
            // and the refetch resolves to the canonical row id.
            let query   = "INSERT IGNORE INTO index_transactions (`hash`) values (?)";
            await this.doQuery(query, [hash]);
            id = await this.getTransactionId(hash);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    },

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id  = null;
        let str = String(address);
        let pid = str.substring(1); // Possible ADDRESS ID (everything after the ^ prefix)
        // A wire ^<id> address reference resolves directly to the numeric id (mirrors
        // getTickerId). Real crypto addresses (base58/bech32) and the contract-derived
        // C:<CHAIN>:<index> form never begin with '^', so this caret check cannot collide
        // with a legitimate address string. Only the CANONICAL form is accepted (no leading
        // zero, id >= 1) and only when a backing row actually exists in the deterministic
        // set (block_index IS NOT NULL), matching resolveAddressRef: a non-canonical or
        // dangling/out-of-band caret yields null rather than a phantom id. pid is handed to
        // SQL verbatim (never Number()) so a large id keeps full precision.
        if(str.substring(0,1)=='^' && CANONICAL_CARET_ID.test(pid)){
            let results = await this.doQuery("SELECT id FROM index_addresses WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
            if(results.length > 0)
                id = Number(results[0].id);
            return id;
        }
        // Genesis intern cache: serve a non-null hit from memory (see _internCache).
        if(this._internCache !== null){
            let hit = this._internCache.addr.get(str);
            if(hit !== undefined)
                return hit;
        }
        // Otherwise look the id up by the canonical address string.
        if(this.util.isNull(id)){
            let query   = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1";
            let results = await this.doQuery(query, [address]);
            if(results.length > 0)
                id = Number(results[0].id);
        }
        if(id !== null && this._internCache !== null)
            this._internCache.addr.set(str, id);
        return id;
    },

    // XChain-local dispenser fresh-address verdict (b7ecae51 /; gated by
    // dispenser_freshness_activation.js). Returns true iff `address` has PRIOR
    // XChain-tagged activity as of `blockIndex`: an index_addresses row assigned a
    // block_index STRICTLY before blockIndex (BLOCK_INDEX-1 semantics). Used, at/after
    // the freshness flag-day, in place of the external utxo-tracker getFirstSeen HTTP
    // call so the verdict is a deterministic function of chain state (an external,
    // per-node-reachability call in a hashed verdict forks the ledger). An address
    // first interned in THIS block has block_index == blockIndex and does NOT count as
    // prior activity, so a same-block-only GET_ADDRESS is fresh. `block_index IS NOT
    // NULL` excludes out-of-band legacy ids that are never part of the deterministic set.
    async hasXChainActivityBefore(address, blockIndex){
        let results = await this.doQuery(
            "SELECT id FROM index_addresses WHERE `address`=? AND block_index IS NOT NULL AND block_index < ? LIMIT 1",
            [address, blockIndex]);
        return results.length > 0;
    },

    // Handle returning the next explicit id for the `index_addresses` table.
    // Mirrors getNextActionIndex: the surviving MAX(id)+1 (1 on an empty table).
    // Assigning ids explicitly (rather than via AUTO_INCREMENT, which never rewinds
    // on DELETE) lets rollback delete orphaned-block ids and a reapply reproduce the
    // exact same ids, so a wire ^<id> address reference resolves identically on every
    // node. The block-processing loop is single-threaded, so reading MAX then
    // inserting cannot race.
    async getNextAddressId(){
        let id      = 0;
        let results = await this.doQuery("SELECT id FROM index_addresses ORDER BY id DESC LIMIT 1");
        if(results.length > 0)
            id = Number(results[0].id);
        id++;
        return id;
    },

    // Startup invariant probe (#5052): count index rows with a NULL block_index. These are
    // out-of-band (legacy AUTO_INCREMENT) ids that are invisible to ^<id> resolution but
    // inflate the dense counter and signal the DB was not cleanly reindexed from genesis.
    // Warns loudly with the count rather than throwing, so an in-progress migration node is
    // not bricked; the planned clean reindex drives both counts to zero. No-op on a clean DB.
    async warnOnOrphanIndexIds(){
        try {
            let a = await this.doQuery("SELECT COUNT(*) AS c FROM index_addresses WHERE block_index IS NULL");
            let t = await this.doQuery("SELECT COUNT(*) AS c FROM index_tickers WHERE block_index IS NULL");
            let addrOrphans = (a.length > 0) ? Number(a[0].c) : 0;
            let tickOrphans = (t.length > 0) ? Number(t[0].c) : 0;
            if(addrOrphans > 0 || tickOrphans > 0)
                getLogger().warn('Index id invariant: ' + addrOrphans + ' index_addresses and ' + tickOrphans +
                    ' index_tickers rows have a NULL block_index (out-of-band ids). These inflate the ' +
                    'deterministic id counter; a clean genesis reindex is required to restore the invariant.');
        } catch(e){
            // Tolerate a partially-migrated DB (column may not exist yet): degrade to silent.
            getLogger().warn('Index id invariant probe failed (non-fatal):', e.message);
        }
    },

    // Create records in the 'index_addresses' table and return record id
    // @param {address}     string  Address string (or already-resolved value)
    // @param {blockIndex}  integer Block at which the id is first assigned (defaults to
    //                              the block-processing context, this.blockIndex)
    async createAddress(address, blockIndex){
        // Ignore empty address and return NULL
        if(this.util.isNull(address))
            return null;
        // Truncate to 120 characters
        address = String(address).substring(0,120);
        // Defense-in-depth: a raw wire ^<id> reference must be resolved by resolveAddressRef
        // BEFORE it reaches createAddress; it is never a value to intern. If one ever arrives
        // here (a future mis-wired caller), refuse to create a literal "^…" address row.
        // A canonical, existing ^<id> still resolves via getAddressId below; anything else
        // returns null so the caller treats it as a no-op rather than minting a bogus row.
        if(address.substring(0,1) === '^')
            return await this.getAddressId(address);
        let id = await this.getAddressId(address);
        // Create address if it does not already exist
        if(id === null){
            // Rollback refresh phase: resolve-only, never assign a new id. An address that
            // no longer exists here existed only in the just-rolled-back blocks; recreating
            // it would resurrect the deleted id and re-open the wire ^<id> fork. See
            // suppressIndexIdCreation (constructor) and rollback.js. Returns null; the
            // refresh callers treat a null address_id as a no-op (no balances to update).
            if(this.suppressIndexIdCreation)
                return null;
            if(this.transactionConnection != null){
                // Block-processing context: assign a deterministic dense id and stamp the
                // block, so the id is reorg-reproducible and ^<id> resolves identically on
                // every node. Ids are assigned in caller order; Actions.assignActionAddressIds
                // registers an action's new wire-field addresses FIRST, in byte-sorted VALUE
                // order, so the within-action id order is pinned by value, not field layout.
                // INSERT IGNORE keeps this race-safe against the UNIQUE address index (a
                // concurrent same-address insert is skipped; the refetch resolves the row);
                // the explicit id is MAX(id)+1 so it cannot collide with an existing row.
                let bi = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : this.blockIndex;
                id = await this.getNextAddressId();
                let query = "INSERT IGNORE INTO index_addresses (`id`, `address`, `block_index`) values (?, ?, ?)";
                await this.doQuery(query, [id, address, (this.util.isNull(bi) ? null : bi)]);
                id = await this.getAddressId(address);
                // F1a apply hook: this address just received its deterministic in-block id.
                // If recovery staged any rewards for it (recovery_pending_rewards, keyed by the
                // raw address string), materialize them now into validator_rewards under this
                // deterministic source_id. Normal indexing pays one COUNT(*) probe and then
                // short-circuits forever (no recovery in progress => remaining stays 0).
                await this.maybeApplyPendingRewards(address, id, bi);
            } else {
                // Outside block processing (API read paths, recovery seed): keep the legacy
                // AUTO_INCREMENT path with a NULL block_index. These ids are not assigned
                // during consensus block processing, so they are not part of the
                // deterministic/rollback-tracked set. If this fires AFTER deterministic
                // indexing has begun it would bump MAX(id) and offset the dense counter, so
                // warn loudly: it must never happen during the indexing lifetime (#5052).
                if(this.deterministicIndexingStarted)
                    getLogger().warn('Index id invariant: out-of-band index_addresses insert ("' + address +
                        '") after deterministic indexing began; this offsets the id counter.');
                let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)";
                await this.doQuery(query, [address]);
                id = await this.getAddressId(address);
            }
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    },

    // Resolve a wire ^<id> address reference to its canonical address string.
    // Action handlers call this BEFORE validating an address field so the compact
    // ^<id> form the SDK emits by default (addressResolver.compactAddresses) is
    // accepted and credited identically to the full address. The reverse of
    // getAddressId (string -> id), it is deterministic across nodes: index_addresses
    // ids are assigned by the explicit dense counter on the canonical chain
    // (getNextAddressId), so id -> address is the same on every node and reorg-stable.
    //
    // Only a STRICTLY canonical ^<digits> reference is resolved. Any other caret
    // string (^007, ^1.5, ^0x10, ^-1, ^1e3, ^ 1, ^, ^abc) is returned UNCHANGED so the
    // caller's existing isCryptoAddress() format check rejects it; this also keeps a
    // non-integer / out-of-range id off the integer FK columns. Leading zeros are
    // rejected (^007 must not alias to ^7) so a single entity has exactly one wire
    // byte-form. A dangling reference (no such id yet, e.g. a forward reference) is
    // likewise returned unchanged and rejected. The digit string is handed to SQL
    // verbatim (never via Number()), so a large id keeps full precision and an
    // out-of-range id simply matches no row.
    //
    // returning the value unchanged states no verdict, so rejection depends on
    // the caller's own format check. Prefer resolveAddressRefChecked below, which
    // resolves identically and additionally reports the activation-gated hard-invalid
    // verdict; this raw form stays for callers with no block context.
    async resolveAddressRef(value){
        if(this.util.isNull(value))
            return value;
        let str = String(value);
        if(str.substring(0,1) !== '^')
            return value;
        let pid = str.substring(1);
        if(!CANONICAL_CARET_ID.test(pid))
            return value;
        // F2 (deterministic-set gate): resolve a wire ^<id> ONLY to an id in the
        // deterministic set (block_index IS NOT NULL). Ids assigned out-of-band
        // (recovery pre-seed; see createAddress) are NOT reproducible across nodes, so
        // resolving a ^id to one would fork. A non-deterministic / nonexistent id leaves
        // the value unchanged, so the caller's isCryptoAddress check rejects it the same
        // way on every node. No-op on current data (no out-of-band ids exist outside
        // dormant recovery). See.
        let results = await this.doQuery("SELECT address FROM index_addresses WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
        if(results.length > 0 && !this.util.isNull(results[0].address))
            return String(results[0].address);
        return value;
    },

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        let results = await this.doQuery(query, [action]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_actions' table and return record id
    async createAction(action){
        var id = await this.getActionId(action);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch keeps this consistent with the other index_*
            // upserts. NOTE: index_actions carries only a non-unique index, so IGNORE
            // does not itself prevent duplicate rows under true concurrency - the
            // single-threaded block-processing loop is what serializes these inserts.
            let query = "INSERT IGNORE INTO index_actions (action) values (?)";
            await this.doQuery(query, [action]);
            id = await this.getActionId(action);
        }
        return id;
    },

    // Lookup a record in the `index_tickers` table and return record tick
    async getTicker(tick_id){
        let tick    = null;
        let query   = "SELECT tick FROM index_tickers WHERE id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            tick = results[0].tick;
        return tick;
    },

    // Cached tick_id -> canonical name resolver for the light-client touched-key
    // set. A resolved mapping is stable WITHIN a chain segment, so the name is
    // cached; it is NOT immutable across a reorg, because a rollback deletes
    // index_tickers rows above the reorg point and frees their dense ids for
    // createTicker to reassign. rollback.js therefore drops this cache on
    // completion. A stale entry here keys the touched set to the OLD
    // tick name, which commits no leaf at all and moves no root.
    //
    // AN ABSENCE IS NOT CACHED, and that distinction is the whole point.
    // The immutability argument covers names only: an id with no row *right now*
    // can have one moments later, because tickers are interned during block
    // processing, and a rollback can delete an id that is then re-interned. If a
    // null were cached, createLedgerChangeRecord's `canonTick != null` guard would
    // skip EVERY later touch for that tick, permanently, for the connection
    // lifetime, and the balance leaf would silently never be committed. That is
    // all-or-nothing per ticker, which is exactly the shape found on BTC regtest:
    // 4 tickers of 276 with every one of their keys missing from the committed
    // balances_root, and 0 tickers missing only some.
    //
    // The read is STRICT for the same reason (M-17): through doQuery a transient
    // fault returns [], which this function cannot distinguish from "no such
    // ticker". Soft-failing into a cached absence is the two defects composing
    // into a permanent, silent consensus omission, so the read throws instead and
    // the block is retried.
    // Cached address_id -> canonical address resolver, the address-axis twin of
    // _smtTickName and subject to exactly the same rules: an ABSENCE is never
    // cached, the read is STRICT so a transient fault throws instead of being
    // indistinguishable from "no such address", and the cache is only valid
    // WITHIN a chain segment. A rollback frees dense ids for reuse, so
    // rollback.js drops this cache when it completes. Do not restore the
    // old "the mapping is immutable" justification: it is true only until a
    // reorg reassigns the id.
    async _smtAddressName(address_id){
        if(!this._smtAddressNameCache) this._smtAddressNameCache = new Map();
        if(this._smtAddressNameCache.has(address_id)) return this._smtAddressNameCache.get(address_id);
        let rows = await this.doQueryStrict("SELECT address FROM index_addresses WHERE id=? LIMIT 1", [address_id]);
        let name = (rows.length > 0) ? rows[0].address : null;
        if(name != null && name !== '')
            this._smtAddressNameCache.set(address_id, name);
        return name;
    },

    async _smtTickName(tick_id){
        if(!this._smtTickNameCache) this._smtTickNameCache = new Map();
        if(this._smtTickNameCache.has(tick_id)) return this._smtTickNameCache.get(tick_id);
        let rows = await this.doQueryStrict("SELECT tick FROM index_tickers WHERE id=? LIMIT 1", [tick_id]);
        let name = (rows.length > 0) ? rows[0].tick : null;
        if(name != null && name !== '')
            this._smtTickNameCache.set(tick_id, name);
        return name;
    },

    // Lookup a record in the `index_tickers` table and return record id
    async getTickerId(tick){
        let id  = null;
        let str = String(tick);
        let pid = str.substring(1); // Possible TICK ID (everything after the ^ prefix)
        // A wire ^<id> ticker reference resolves directly to the numeric id. Unlike the
        // address axis there is no resolveTickerRef shim, so this IS the live consumption
        // path for a wire ^<tickid>; it must be as strict as resolveAddressRef. Only the
        // CANONICAL form is accepted (no leading zero, id >= 1) and only when a backing row
        // exists in the deterministic set (block_index IS NOT NULL): a non-canonical or
        // dangling/out-of-band caret yields null so the handler rejects it as an unknown
        // ticker. pid is handed to SQL verbatim (never Number()) to keep full precision.
        if(str.substring(0,1)=='^' && CANONICAL_CARET_ID.test(pid)){
            let results = await this.doQuery("SELECT id FROM index_tickers WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
            if(results.length > 0)
                id = Number(results[0].id);
            return id;
        }
        // Genesis intern cache: serve a non-null hit from memory, keyed by LOWER(tick) to
        // match the case-insensitive lookup below (see _internCache).
        let lc = String(tick).toLowerCase();
        if(this._internCache !== null){
            let hit = this._internCache.tick.get(lc);
            if(hit !== undefined)
                return hit;
        }
        // Try to lookup id using tick passed
        if(this.util.isNull(id)){
            let query   = "SELECT id FROM index_tickers WHERE LOWER(tick)=? LIMIT 1";
            let args    = [lc];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                id = Number(results[0].id);
        }
        if(id !== null && this._internCache !== null)
            this._internCache.tick.set(lc, id);
        return id;
    },

    // Handle returning the next explicit id for the `index_tickers` table.
    // Same deterministic dense-counter role as getNextAddressId (see its note): a wire
    // ^<id> ticker reference resolves through this id, so it must be rollback-reproducible.
    async getNextTickerId(){
        let id      = 0;
        let results = await this.doQuery("SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1");
        if(results.length > 0)
            id = Number(results[0].id);
        id++;
        return id;
    },

    // Create records in the 'index_tickers' table and return record id
    // @param {tick}        string  Ticker name (or already-resolved value)
    // @param {blockIndex}  integer Block at which the id is first assigned (defaults to
    //                              the block-processing context, this.blockIndex)
    async createTicker(tick, blockIndex){
        // Ignore empty tick and return NULL
        if(this.util.isNull(tick))
            return null;
        // Defense-in-depth: a raw wire ^<id> ticker reference is resolved by getTickerId, never
        // interned as a literal "^…" tick row. A canonical, existing ^<id> still resolves via
        // getTickerId below; anything else returns null rather than minting a bogus row.
        if(String(tick).substring(0,1) === '^')
            return await this.getTickerId(tick);
        let id = await this.getTickerId(tick);
        // Create ticker if it does not already exist
        if(id === null){
            // Rollback refresh phase: resolve-only, never assign a new id. A tick that no
            // longer exists here existed only in the just-rolled-back blocks; recreating it
            // would resurrect the deleted id and re-open the wire ^<id> fork. See
            // suppressIndexIdCreation (constructor) and rollback.js. Returns null; the
            // refresh callers treat a null tick_id as a no-op (getTokenInfo finds no row).
            if(this.suppressIndexIdCreation)
                return null;
            if(this.transactionConnection != null){
                // Block-processing context: assign a deterministic dense id and stamp the
                // block (reorg-reproducible; see createAddress). One ISSUE introduces one
                // new tick under its own action_index, so action ordering already pins the
                // tick id order; the explicit counter + block_index make it rollback-safe.
                // The get-first lookup is retained because getTickerId() matches
                // case-insensitively (LOWER(tick)) while the UNIQUE index is binary;
                // refetching through getTickerId keeps that case-folding behaviour.
                let bi = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : this.blockIndex;
                id = await this.getNextTickerId();
                let query = "INSERT IGNORE INTO index_tickers (`id`, `tick`, `block_index`) values (?, ?, ?)";
                await this.doQuery(query, [id, tick, (this.util.isNull(bi) ? null : bi)]);
                id = await this.getTickerId(tick);
            } else {
                // Outside block processing: keep the legacy AUTO_INCREMENT path (NULL block_index).
                // As with createAddress, an out-of-band insert after deterministic indexing began
                // offsets the dense id counter and must never happen during indexing (#5052).
                if(this.deterministicIndexingStarted)
                    getLogger().warn('Index id invariant: out-of-band index_tickers insert ("' + tick +
                        '") after deterministic indexing began; this offsets the id counter.');
                let query = "INSERT IGNORE INTO index_tickers (tick) values (?)";
                await this.doQuery(query, [tick]);
                id = await this.getTickerId(tick);
            }
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    },

    // Lookup a record in the `index_statuses` table and return record id
    async getStatusId(status){
        let id    = null;
        let query = "SELECT id FROM index_statuses WHERE status=? LIMIT 1";
        let results = await this.doQuery(query, [status]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_statuses' table and return record id
    async createStatus(status){
        // Ignore empty status and return NULL
        if(this.util.isNull(status))
            return null;
        var id = await this.getStatusId(status);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_statuses (status) values (?)";
            await this.doQuery(query, [status]);
            id = await this.getStatusId(status);
        }
        return id;
    },

    // Lookup a record in the `index_memos` table and return record id
    async getMemoId(memo){
        let id    = null;
        let query = "SELECT id FROM index_memos WHERE memo=? LIMIT 1";
        let results = await this.doQuery(query, [memo]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_memos' table and return record id
    async createMemo(memo){
        // Ignore empty memo and return NULL
        if(this.util.isNull(memo))
            return null;
        // Truncate memos to 250 characters
        memo = String(memo).substring(0,250);
        var id = await this.getMemoId(memo);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_memos (memo) values (?)";
            await this.doQuery(query, [memo]);
            id = await this.getMemoId(memo);
        }
        return id;
    },

    // Lookup a record in the `index_mime_types` table and return record id
    async getMimeTypeId(type){
        let id    = null;
        let query = "SELECT id FROM index_mime_types WHERE `type`=? LIMIT 1";
        let args  = [type];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_mime_types' table and return record id
    async createMimeType(type){
        // Ignore empty mime type and return NULL
        if(this.util.isNull(type))
            return null;
        var id = await this.getMimeTypeId(type);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_mime_types (`type`) values (?)";
            let args  = [type];
            await this.doQuery(query, args);
            id = await this.getMimeTypeId(type);
        }
        return id;
    },

    // Lookup a record in the `index_coins` table and return record id
    async getCoinId(coin){
        let id    = null;
        let query = "SELECT id FROM index_coins WHERE `coin`=? LIMIT 1";
        let args  = [coin];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_coins' table and return record id
    async createCoin(coin){
        // Ignore empty coin and return NULL
        if(this.util.isNull(coin))
            return null;
        var id = await this.getCoinId(coin);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_coins (`coin`) values (?)";
            let args  = [coin];
            await this.doQuery(query, args);
            id = await this.getCoinId(coin);
        }
        return id;
    },

    // Lookup a record in the `index_fiats` table and return record id
    async getFiatId(code){
        let id    = null;
        let query = "SELECT id FROM index_fiats WHERE `code`=? LIMIT 1";
        let args  = [code];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create records in the 'index_fiats' table and return record id
    async createFiat(code){
        // Ignore empty fiat and return NULL
        if(this.util.isNull(code))
            return null;
        var id = await this.getFiatId(code);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_fiats (`code`) values (?)";
            let args  = [code];
            await this.doQuery(query, args);
            id = await this.getFiatId(code);
        }
        return id;
    },

    // Verify that a given action_index is associated with a `valid` transaction
    async isActionIndexValid(action_index){
        let valid = false;
        let table = await this.getActionIndexTable(action_index);
        if(!this.util.isNull(table)){
            let query = `SELECT 
                            m.action_index
                        FROM 
                            ` + table + ` m
                            LEFT JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.action_index=? AND
                            s.status='valid'`;
            let args = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                valid = true;
        }
        return valid;
    },

    // Resolve a deterministic index_addresses id back to its address string. Used by
    // VOTE v2 to find the deposit refund target (deposit_address_id was assigned via
    // createAddress at creation, so it is in the deterministic set). Null if missing.
    async getAddressById(id){
        if(this.util.isNull(id)) return null;
        let results = await this.doQuery(`SELECT address FROM index_addresses WHERE id=? LIMIT 1`, [id]);
        return (results.length > 0 && !this.util.isNull(results[0].address)) ? String(results[0].address) : null;
    },

    // Lookup items that need to be expired and return a list
    //
    // The expiration cut is applied IN SQL rather than by pulling the ENTIRE
    // open order/swap/dispenser book back to the client every block, resolving the
    // edits overlay with a second batched query per type, and only then applying
    // the cutoff in JS: that shape scales per-block row transfer and memory with
    // the whole open book rather than the (usually tiny) set expiring this block.
    // The returned rows, their order, and their values are identical either way.
    //
    // NULL expiration semantics - CONSENSUS-CRITICAL, preserved exactly:
    // all six `expiration` columns (orders/swaps/dispensers and their `_edits`)
    // are nullable. The old JS predicate was `info.expiration < block_time`,
    // where JS coerces a null expiration to 0, so a null effective expiration
    // meant "expired at time 0" and the item expired on the first block that
    // swept it. A naive SQL `eff_expiration < ?` evaluates to NULL for those
    // rows, drops them, and that item would NEVER expire - a silent consensus
    // change. `COALESCE(eff_expiration, 0) < ?` is the byte-equivalent form and
    // is what is used below. Note this deliberately does NOT agree with
    // getOpenCrossChainOffers, which keeps a null-expiration offer as
    // never-expiring; that divergence is pre-existing and out of scope here.
    // In practice a null BASE expiration is unreachable on current code: the
    // ORDER/SWAP/DISPENSER create handlers all fill in util.getDefaultExpiration()
    // when the field is absent. Null EDIT expirations are normal and mean "leave
    // the expiration unchanged".
    //
    // Effective expiration = the last `valid` edit carrying a non-null expiration
    // (highest edit action_index), else the base row's expiration. That is the
    // same rule the old ascending "last non-null wins" JS loop implemented, and
    // the same overlay getOpenCrossChainOffers applies.
    async getExpiredItems(block_time){
        let expired = [];
        let types   = ['order','swap','dispenser'];
        let query   = '';
        let args    = [];
        // A non-numeric block_time made every old JS compare false (`x < undefined`,
        // `x < null` compared against 0), so nothing expired. Return that same answer
        // instead of binding NULL/NaN into SQL, where comparison semantics differ.
        let cutoff = Number(block_time);
        if(this.util.isNull(block_time) || !Number.isFinite(cutoff))
            return expired;
        // Build out the query for each of the table types to get 'open' items whose
        // effective expiration has already passed.
        for(let type of types){
            if(query!='')
                query += 'UNION ';
            // Scalar subquery for the edits overlay: newest `valid` edit that actually
            // set an expiration wins, NULL when the item has no such edit.
            let editExpiration = `(
                            SELECT
                                e1.expiration
                            FROM
                                ` + type + `_edits e1
                                INNER JOIN index_statuses e2 ON (e2.id=e1.status_id)
                            WHERE
                                e1.` + type + `_action_index=m.action_index AND
                                e2.status='valid' AND
                                e1.expiration IS NOT NULL
                            ORDER BY
                                e1.action_index DESC
                            LIMIT 1
                        )`;
            query += `SELECT
                        m.action_index,
                        COALESCE(` + editExpiration + `, m.expiration) as expiration,
                        '` + type + `' as type
                    FROM
                        ` + type + `s m
                        INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                        INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                ` + type + `_statuses s3
                            WHERE
                                s3.` + type + `_action_index=m.action_index
                        ) AND
                        s2.status='open' AND
                        COALESCE(` + editExpiration + `, m.expiration, 0) < ? `;
            args.push(cutoff);
        }
        // Process expirations in ascending global action_index order so every
        // instance derives identical AUTO_INCREMENT IDs for the same block.
        // (UNION result: order by the output column name, not a table alias.)
        query += ' ORDER BY action_index ASC';
        let results = await this.doQuery(query, args);
        for(let info of results){
            expired.push({
                type:         info.type,
                action_index: Number(info.action_index),
                // Number(null) === 0, matching the old null-coerced expiration value.
                expiration:   Number(info.expiration)
            });
        }
        return expired;
    },

    /*
     * Pubkey index methods (index_pubkeys table)
     */

    // Get pubkey id from index_pubkeys table
    async getPubkeyId(pubkey){
        let id    = null;
        let query = "SELECT id FROM index_pubkeys WHERE `pubkey`=? LIMIT 1";
        let results = await this.doQuery(query, [pubkey]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Create record in index_pubkeys table and return record id
    async getOrCreatePubkeyId(pubkey){
        // Ignore empty pubkey and return NULL
        if(this.util.isNull(pubkey))
            return null;
        // Normalize to lowercase hex
        pubkey = String(pubkey).toLowerCase().substring(0, 64);
        let id = await this.getPubkeyId(pubkey);
        // Create pubkey if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query   = "INSERT IGNORE INTO index_pubkeys (`pubkey`) values (?)";
            await this.doQuery(query, [pubkey]);
            id = await this.getPubkeyId(pubkey);
        }
        return id;
    },

    // Get status string by status_id
    async getStatusString(status_id){
        if(this.util.isNull(status_id))
            return null;
        let query = `SELECT status FROM index_statuses WHERE id=? LIMIT 1`;
        let results = await this.doQuery(query, [status_id]);
        if(results.length > 0)
            return results[0].status;
        return null;
    },

};
