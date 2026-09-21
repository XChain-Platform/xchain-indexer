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
 * XChain Indexer - Database mixin part: index_tables / tickers
 *
 * The index_tickers reads and the dense-id writer behind every tick id, and the strict
 * light-client name resolvers that map a tick or address id back to its canonical name.
 * Merged into the index_tables mixin by db/index_tables/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { CANONICAL_CARET_ID } = require('../shared.js');

const { getLogger } = require('../../observability/index.js');

module.exports = {

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
    // smtTickName and subject to exactly the same rules: an ABSENCE is never
    // cached, the read is STRICT so a transient fault throws instead of being
    // indistinguishable from "no such address", and the cache is only valid
    // WITHIN a chain segment. A rollback frees dense ids for reuse, so
    // rollback.js drops this cache when it completes. Do not restore the
    // old "the mapping is immutable" justification: it is true only until a
    // reorg reassigns the id.
    async smtAddressName(address_id){
        if(!this._smtAddressNameCache) this._smtAddressNameCache = new Map();
        if(this._smtAddressNameCache.has(address_id)) return this._smtAddressNameCache.get(address_id);
        let rows = await this.doQueryStrict("SELECT address FROM index_addresses WHERE id=? LIMIT 1", [address_id]);
        let name = (rows.length > 0) ? rows[0].address : null;
        if(name != null && name !== '')
            this._smtAddressNameCache.set(address_id, name);
        return name;
    },

    async smtTickName(tick_id){
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
    //
    // Called only by createTicker's active-transaction branch. The maximum is read with a
    // locking current read, so a second transaction blocks on the first until it commits or
    // rolls back and then observes the committed predecessor id. A process-local queue
    // cannot give that guarantee when several processes share the table.
    async getNextTickerId(){
        let id      = 0;
        let results = await this.doQuery("SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1 FOR UPDATE");
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

};
