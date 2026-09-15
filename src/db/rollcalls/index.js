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
 * XChain Indexer - Database mixin: rollcalls
 * 
 * The queries over the rollcalls table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // ROLLCALL presence signatures, DOGE side. Raw hex, never mapper ids: the BTC
    // close queries this table BY KEY over a bounded list it supplies, so an id
    // the caller cannot reproduce would make the answer unusable.
    //
    // INSERT IGNORE on the (epoch_height, pubkey) primary key is what makes this a
    // FIRST-SEEN index: the first valid signature landed for a key in an epoch is
    // the one served, and a later action carrying the same key is a no-op rather
    // than an overwrite. No spam row can pre-empt a real signer, because only the
    // holder of that key can produce a signature that verifies, and the handler
    // has already verified every row it passes here.
    //
    // `gates` is the ROLLCALL v1 GATES field as carried (null on a v0 row), stored raw
    // because the BTC close rebuilds the v1 canonical from it.
    async insertRollcallSigners(rows){
        if(!Array.isArray(rows) || rows.length === 0) return 0;
        let placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        let values = [];
        for(let r of rows){
            values.push(
                parseInt(r.epoch_height),
                String(r.pubkey).toLowerCase(),
                String(r.sig).toLowerCase(),
                String(r.ledger_hash).toLowerCase(),
                String(r.publisher).toLowerCase(),
                parseInt(r.action_index),
                parseInt(r.block_index),
                (r.gates === undefined || r.gates === null) ? null : String(r.gates)
            );
        }
        let query = `INSERT IGNORE INTO rollcall_signers
                        (epoch_height, pubkey, sig, ledger_hash, publisher, action_index, block_index, gates)
                     VALUES ${placeholders}`;
        await this.doQuery(query, values);
        return rows.length;
    },

    // First-seen signature rows for an epoch, BOUNDED BY THE CALLER'S KEY LIST.
    //
    // Bounded on purpose: the answer size is fixed by the asker (|R(E)|), never by
    // how many actions an attacker landed, so there is no page walk to exhaust into
    // a wrong absence. `block_index <= hcut` applies the window.
    async getRollcallSignersForKeys(epochHeight, pubkeys, hcut){
        let e = parseInt(epochHeight), h = parseInt(hcut);
        if(!Number.isFinite(e) || !Number.isFinite(h)) return [];
        if(!Array.isArray(pubkeys) || pubkeys.length === 0) return [];
        let keys = pubkeys.map((k) => String(k).toLowerCase());
        let query = `SELECT epoch_height, pubkey, sig, ledger_hash, publisher, action_index, block_index, gates
                       FROM rollcall_signers
                      WHERE epoch_height = ? AND block_index <= ?
                        AND pubkey IN (${keys.map(() => '?').join(', ')})`;
        return await this.doQuery(query, [e, h].concat(keys));
    },

    // Record each verified signer's gate list at a ROLLED epoch, BTC side, one row per
    // pubkey. Written once per epoch at its close block and by nothing else; an unrolled
    // or v0 epoch passes nothing and writes nothing. `rows` is [{pubkey, gates}] where
    // `gates` is the sorted array of `<module>.<EXPORT>` keys the signer re-signed.
    async insertRollcallGates(epochHeight, closeBlock, rows){
        let e = parseInt(epochHeight), c = parseInt(closeBlock);
        if(!Number.isFinite(e) || !Number.isFinite(c)) return 0;
        if(!Array.isArray(rows) || rows.length === 0) return 0;
        let placeholders = rows.map(() => '(?, ?, ?, ?)').join(', ');
        let values = [];
        for(let r of rows){
            values.push(e, String(r.pubkey).toLowerCase(), c,
                        JSON.stringify((Array.isArray(r.gates) ? r.gates : []).map(String)));
        }
        let query = `INSERT INTO rollcall_gates (epoch_height, pubkey, close_block, gates_json)
                     VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE close_block=VALUES(close_block), gates_json=VALUES(gates_json)`;
        await this.doQuery(query, values);
        return rows.length;
    },

    // The gate lists the rules-aware attestation filter reads for a request whose
    // buried snapshot block is `atOrBelowBlock`: the most recent ROLLED epoch whose
    // close_block is at or below it and whose epoch_height is at or above
    // `minEpochHeight` (the gates activation height), as
    // { epoch_height, close_block, gates: Map<pubkey, string[]> }, or null when no such
    // epoch has closed. Selected by close_block, never by epoch height alone, so the
    // rows are guaranteed to exist from the block the filter first runs at and a
    // replay reads exactly what the live run read. A malformed gates_json row reads
    // as an empty list, which the filter treats as "knows no gate" and drops.
    async getRollcallGatesForFilter(atOrBelowBlock, minEpochHeight){
        let b = parseInt(atOrBelowBlock), m = parseInt(minEpochHeight);
        if(!Number.isFinite(b) || !Number.isFinite(m)) return null;
        let epochs = await this.doQuery(
            `SELECT epoch_height, close_block FROM rollcalls
              WHERE rolled = 1 AND close_block <= ? AND epoch_height >= ?
              ORDER BY epoch_height DESC LIMIT 1`, [b, m]);
        if(!epochs || epochs.length === 0) return null;
        let epoch = parseInt(epochs[0].epoch_height), close = parseInt(epochs[0].close_block);
        let rows = await this.doQuery(
            `SELECT pubkey, gates_json FROM rollcall_gates WHERE epoch_height = ?`, [epoch]);
        let gates = new Map();
        for(let r of (rows || [])){
            let list = [];
            try { let parsed = JSON.parse(String(r.gates_json)); if(Array.isArray(parsed)) list = parsed.map(String); }
            catch(_){ list = []; }
            gates.set(String(r.pubkey).toLowerCase(), list);
        }
        return { epoch_height: epoch, close_block: close, gates };
    },

    // Earliest in-window ROLLCALL for an epoch published by each requested key.
    // Feeds the publish reward, which pays the ELECTED leader only, so the caller
    // asks about exactly one key in practice.
    async getRollcallPublishers(epochHeight, publishers, hcut){
        let e = parseInt(epochHeight), h = parseInt(hcut);
        if(!Number.isFinite(e) || !Number.isFinite(h)) return [];
        if(!Array.isArray(publishers) || publishers.length === 0) return [];
        let keys = publishers.map((k) => String(k).toLowerCase());
        let query = `SELECT publisher, MIN(action_index) AS action_index, MIN(block_index) AS block_index
                       FROM rollcall_signers
                      WHERE epoch_height = ? AND block_index <= ?
                        AND publisher IN (${keys.map(() => '?').join(', ')})
                      GROUP BY publisher`;
        return await this.doQuery(query, [e, h].concat(keys));
    },

    // Record an epoch's close verdict, BTC side. Written once per epoch at C,
    // whether or not it rolled: an epoch missing from this table is
    // indistinguishable from one that has not closed yet, and the K-streak has to
    // know which epochs to skip.
    //
    // `responsibleSources` is pinned here and never re-derived (see the table
    // comment). Pass it only for a ROLLED epoch; an unrolled one decides nothing
    // and stores NULL.
    async insertRollcall(epochHeight, snapshotBlock, closeBlock, rolled, responsibleSources){
        let e = parseInt(epochHeight);
        if(!Number.isFinite(e)) return false;
        let pinned = (rolled && Array.isArray(responsibleSources))
                   ? JSON.stringify(responsibleSources.map((s) => String(s)))
                   : null;
        let query = `INSERT INTO rollcalls (epoch_height, snapshot_block, close_block, rolled, responsible_set_json)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE snapshot_block=VALUES(snapshot_block),
                                             close_block=VALUES(close_block),
                                             rolled=VALUES(rolled),
                                             responsible_set_json=VALUES(responsible_set_json)`;
        await this.doQuery(query, [e, parseInt(snapshotBlock), parseInt(closeBlock), rolled ? 1 : 0, pinned]);
        return true;
    },

    // Pin one absence row per responsible source that did not sign at a ROLLED
    // epoch. `evicted` marks the rows that completed a K-streak at this close; it
    // is the key the rollback's delegations repair finds the affected sources by,
    // because an eviction writes no DELEGATE-revoke row to self-join on.
    async insertRollcallAbsences(rows){
        if(!Array.isArray(rows) || rows.length === 0) return 0;
        let values = [], placeholders = [];
        for(let r of rows){
            let source_id = await this.getAddressId(r.source);
            if(source_id === null) continue;   // a source with no address row cannot have staked
            placeholders.push('(?, ?, ?, ?)');
            values.push(parseInt(r.epoch_height), source_id, parseInt(r.close_block), r.evicted ? 1 : 0);
        }
        if(placeholders.length === 0) return 0;
        let query = `INSERT INTO rollcall_absences (epoch_height, source_id, close_block, evicted)
                     VALUES ${placeholders.join(', ')}
                     ON DUPLICATE KEY UPDATE close_block=VALUES(close_block), evicted=VALUES(evicted)`;
        await this.doQuery(query, values);
        return placeholders.length;
    },

    // The last `limit` ROLLED epochs at or below `beforeEpochHeight`, newest first,
    // each with its pinned responsible set. This is the streak's lookback window:
    // unrolled epochs are excluded here rather than filtered later, so they are
    // never counted and never streak-ending.
    async getRolledRollcallEpochs(beforeEpochHeight, limit){
        let e = parseInt(beforeEpochHeight), n = parseInt(limit);
        if(!Number.isFinite(e) || !Number.isFinite(n) || n <= 0) return [];
        let query = `SELECT epoch_height, snapshot_block, close_block, responsible_set_json
                       FROM rollcalls
                      WHERE rolled = 1 AND epoch_height <= ?
                      ORDER BY epoch_height DESC
                      LIMIT ?`;
        return await this.doQuery(query, [e, n]);
    },

    // Which of `epochHeights` this source was recorded absent at. Bounded by the
    // caller's list, which is the lookback window, so the answer size is fixed by
    // the protocol constant rather than by history.
    async getRollcallAbsenceEpochsForSource(source, epochHeights){
        if(!Array.isArray(epochHeights) || epochHeights.length === 0) return [];
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let epochs = epochHeights.map((h) => parseInt(h)).filter((h) => Number.isFinite(h));
        if(epochs.length === 0) return [];
        let query = `SELECT epoch_height FROM rollcall_absences
                      WHERE source_id = ? AND epoch_height IN (${epochs.map(() => '?').join(', ')})`;
        let rows = await this.doQuery(query, [source_id].concat(epochs));
        return rows.map((r) => parseInt(r.epoch_height));
    },

    // Public roll-call verdict history, BTC side (JSON-RPC getrollcalls). Newest
    // first, each row carrying its absence count via a correlated subquery rather
    // than a stored counter, since an UNROLLED epoch writes no absences by
    // construction and the count must fall out of that rather than be tracked in
    // parallel. Never selects responsible_set_json: that field pins K-streak
    // membership and is an internal detail, not a public one.
    //
    // STRICT on purpose. doQuery collapses a non-transactional query error into
    // [], which here would be indistinguishable from "no epoch has closed yet",
    // and the consumer that matters treats an empty list as SILENCE: the
    // dashboard's consecutive-unrolled alarm is the only detector for a
    // federation that has stopped rolling, so a missing table or a broken query
    // would hand it a permanently quiet answer about a permanently broken rail.
    // Driven, not assumed: run against the regtest BTC indexer before the
    // migration was applied, doQuery logged ER_NO_SUCH_TABLE and returned rows=0.
    async getRollcalls(limit){
        let n = parseInt(limit);
        if(!Number.isFinite(n) || n <= 0) n = 20;
        if(n > 100) n = 100;
        let query = `SELECT r.epoch_height, r.snapshot_block, r.close_block, r.rolled,
                            (SELECT COUNT(*) FROM rollcall_absences ra
                              WHERE ra.epoch_height = r.epoch_height) AS absent_count
                       FROM rollcalls r
                      ORDER BY r.epoch_height DESC
                      LIMIT ?`;
        return await this.doQueryStrict(query, [n]);
    },

    // Public roll-call absences for one staking source, BTC side (JSON-RPC
    // getrollcallabsences). `source` is an address as a caller types it, resolved
    // to source_id the same way every other address-keyed read on this table does
    // (getRollcallAbsenceEpochsForSource, getSweepableStakeBySource); an unknown
    // or unresolvable address is not an error, it just has no absences on file.
    // The join back to index_addresses hands the caller the canonical address
    // string rather than echoing its raw input, so a `^<id>` wire reference
    // resolves to the real address in the response.
    //
    // STRICT for the same reason as getRollcalls: an operator reading `validator
    // status` must never see "no absences on record" because the query failed.
    // That reading is the one that makes them stop worrying.
    async getRollcallAbsencesBySource(source, limit){
        let n = parseInt(limit);
        if(!Number.isFinite(n) || n <= 0) n = 20;
        if(n > 100) n = 100;
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let query = `SELECT a.epoch_height, ia.address AS source, a.close_block, a.evicted
                       FROM rollcall_absences a
                       INNER JOIN index_addresses ia ON (ia.id = a.source_id)
                      WHERE a.source_id = ?
                      ORDER BY a.epoch_height DESC
                      LIMIT ?`;
        return await this.doQueryStrict(query, [source_id, n]);
    },

};
