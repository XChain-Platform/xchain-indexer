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
 * XChain Indexer - Database mixin part: index_tables / addresses
 *
 * The index_addresses reads and the dense-id writer behind every address id: the
 * wire ^<id> lookup and resolver, the prior-activity probe and the orphan-id startup probe.
 * Merged into the index_tables mixin by db/index_tables.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { CANONICAL_CARET_ID } = require('../shared.js');

const { getLogger } = require('../../observability/index.js');

module.exports = {

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
            if(this.transactionConnection != null)
                id = await newAddressIds.assignInBlock(this, address, blockIndex);
            else
                id = await newAddressIds.insertOutOfBand(this, address);
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

};

// The two ways createAddress mints a missing address id, kept off the exported object so
// Database.prototype gains no method. Each returns the id its refetch resolved.
const newAddressIds = {

    async assignInBlock(db, address, blockIndex){
        // Block-processing context: assign a deterministic dense id and stamp the
        // block, so the id is reorg-reproducible and ^<id> resolves identically on
        // every node. Ids are assigned in caller order; Actions.assignActionAddressIds
        // registers an action's new wire-field addresses FIRST, in byte-sorted VALUE
        // order, so the within-action id order is pinned by value, not field layout.
        // INSERT IGNORE keeps this race-safe against the UNIQUE address index (a
        // concurrent same-address insert is skipped; the refetch resolves the row);
        // the explicit id is MAX(id)+1 so it cannot collide with an existing row.
        let bi = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : db.blockIndex;
        let id = await db.getNextAddressId();
        let query = "INSERT IGNORE INTO index_addresses (`id`, `address`, `block_index`) values (?, ?, ?)";
        await db.doQuery(query, [id, address, (db.util.isNull(bi) ? null : bi)]);
        id = await db.getAddressId(address);
        // F1a apply hook: this address just received its deterministic in-block id.
        // If recovery staged any rewards for it (recovery_pending_rewards, keyed by the
        // raw address string), materialize them now into validator_rewards under this
        // deterministic source_id. Normal indexing pays one COUNT(*) probe and then
        // short-circuits forever (no recovery in progress => remaining stays 0).
        await db.maybeApplyPendingRewards(address, id, bi);
        return id;
    },

    async insertOutOfBand(db, address){
        // Outside block processing (API read paths, recovery seed): keep the legacy
        // AUTO_INCREMENT path with a NULL block_index. These ids are not assigned
        // during consensus block processing, so they are not part of the
        // deterministic/rollback-tracked set. If this fires AFTER deterministic
        // indexing has begun it would bump MAX(id) and offset the dense counter, so
        // warn loudly: it must never happen during the indexing lifetime (#5052).
        if(db.deterministicIndexingStarted)
            getLogger().warn('Index id invariant: out-of-band index_addresses insert ("' + address +
                '") after deterministic indexing began; this offsets the id counter.');
        let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)";
        await db.doQuery(query, [address]);
        return await db.getAddressId(address);
    },

};
