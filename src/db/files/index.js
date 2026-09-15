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
 * XChain Indexer - Database mixin: files
 * 
 * The queries over the files table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `files` table
    async createFile(data){
        data             = this.normalizeDataValues(data);
        let type_id      = await this.createMimeType(data['TYPE']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let name         = data['NAME'];
        let title        = data['TITLE'];
        // Check if record already exists for this file
        let query  = `SELECT
                            action_index
                        FROM
                            files
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        files
                    SET
                        name=?,
                        title=?,
                        type_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO files (name, title, type_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [name, title, type_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

    // Create/Update record in `gated_files` table.
    // Called by the FILE handler when GATE_TICKER is non-empty.
    // Mirrors the ciphertext bytes (data['RAW_DATA']) so the explorer can
    // serve them via /api/file/{action_index}/raw without reaching across
    // databases. See xchain-documentation/protocol/token-gated-content.md.
    async createGatedFile(data){
        data              = this.normalizeDataValues(data);
        let action_index  = data['ACTION_INDEX'];
        let gate_ticker   = data['GATE_TICKER'];
        let enc_method    = Number(data['ENCRYPTION_METHOD']) || 1;
        let key_hash      = String(data['KEY_HASH'] || '').toLowerCase();
        // PC-29: the publishing SOURCE scopes the pack, and the threshold governs it.
        // An empty/absent threshold is stored as NULL, never '': the pack rule reads
        // "any file with no threshold makes the pack unconditional", and having two
        // spellings of "no threshold" would make that rule depend on which one landed.
        let publisher     = String(data['SOURCE'] || '');
        let min_amount    = (data['GATE_MIN_AMOUNT'] === undefined || data['GATE_MIN_AMOUNT'] === null ||
                             String(data['GATE_MIN_AMOUNT']) === '') ? null : String(data['GATE_MIN_AMOUNT']);
        let status_id     = await this.createStatus(data['STATUS']);
        let raw_data      = data['RAW_DATA'] || null;

        let exists = false;
        let q = `SELECT action_index FROM gated_files WHERE action_index=?`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length > 0) exists = true;

        let query;
        let args;
        if(exists){
            query = `UPDATE gated_files SET gate_ticker=?, encryption_method=?, key_hash=?, publisher_address=?, gate_min_amount=?, status_id=?, raw_data=? WHERE action_index=?`;
            args  = [gate_ticker, enc_method, key_hash, publisher, min_amount, status_id, raw_data, action_index];
        } else {
            query = `INSERT INTO gated_files (action_index, gate_ticker, encryption_method, key_hash, publisher_address, gate_min_amount, status_id, raw_data) values (?, ?, ?, ?, ?, ?, ?, ?)`;
            args  = [action_index, gate_ticker, enc_method, key_hash, publisher, min_amount, status_id, raw_data];
        }
        await this.doQuery(query, args);
    },

    // Fetch the raw ciphertext bytes for a gated FILE by ACTION_INDEX.
    // Returns null when no such gated file exists. Used by the explorer's
    // /api/file/{action_index}/raw endpoint.
    async getGatedFileRaw(action_index){
        let q = `SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length === 0) return null;
        return r[0].raw_data;
    },

    // Return the set of distinct KEY_HASH values across all currently-active
    // gated FILE v1 actions for a given token. Used by the SEND processor
    // to determine whether a transfer requires a paired MESSAGE handoff.
    // A pack of N files contributes one entry. Returns [] if the token has
    // no gated content.
    // PC-29: the gated PACKS for a token, with each pack's effective threshold.
    //
    // A pack is (publisher_address, gate_ticker, key_hash): files that share one key
    // and unlock together. Its EFFECTIVE THRESHOLD is the MINIMUM gate_min_amount
    // across its files, and any file with no threshold makes the whole pack
    // unconditional, because that file is readable by anyone holding the key and the
    // key is shared across the pack.
    //
    // The minimum is computed HERE IN JS, not with SQL MIN(). gate_min_amount is a
    // VARCHAR, so SQL MIN() compares lexicographically: it would rank '100' below
    // '9' and pick a threshold ten times too small. Decimal comparison has to go
    // through the same bignumber helpers consensus uses everywhere else.
    //
    // Returns [{ publisher, keyHash, threshold }] where threshold === null means the
    // pack is unconditional. Ordered deterministically so two nodes building the same
    // list from the same rows agree, for the same reason #3085 needed an ORDER BY.
    async getGatedPackThresholds(tick){
        let q = `SELECT gf.publisher_address, gf.key_hash, gf.gate_min_amount
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'
                 ORDER BY gf.publisher_address ASC, gf.key_hash ASC, gf.action_index ASC`;
        let rows = await this.doQuery(q, [tick]);
        let packs = new Map();
        for(let r of rows){
            let publisher = r.publisher_address == null ? '' : String(r.publisher_address);
            let keyHash   = String(r.key_hash || '').toLowerCase();
            let key       = publisher + '|' + keyHash;
            let raw       = (r.gate_min_amount == null || String(r.gate_min_amount) === '')
                          ? null : String(r.gate_min_amount);
            let pack = packs.get(key);
            if(pack === undefined){
                packs.set(key, { publisher, keyHash, threshold: raw, unconditional: (raw === null) });
                continue;
            }
            // Once any file in the pack carries no threshold the pack is
            // unconditional, and no later file can re-impose one.
            if(pack.unconditional) continue;
            if(raw === null){ pack.unconditional = true; pack.threshold = null; continue; }
            if(this.util.bclt(raw, pack.threshold)) pack.threshold = raw;
        }
        return Array.from(packs.values()).map(p => ({
            publisher: p.publisher, keyHash: p.keyHash,
            threshold: p.unconditional ? null : p.threshold
        }));
    },

    async getActiveGatedKeyHashes(tick){
        // Active = status maps to 'valid' (the canonical accepted status id).
        let q = `SELECT DISTINCT gf.key_hash
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'`;
        let r = await this.doQuery(q, [tick]);
        return r.map((row) => String(row.key_hash).toLowerCase());
    },

};
