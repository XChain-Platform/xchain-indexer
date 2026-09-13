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
 * XChain Indexer - Database mixin: attests
 * 
 * The queries over the attests table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../protocol/constants.js');
const { CHECKPOINT_VERSIONS: ANCHOR_CHECKPOINT_VERSIONS,
        ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
        ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow,
        dedupeArchiveChunks } = require('../anchor-action-query');
// The ATTEST batch wire versions, taken from the codec rather than written as literals
// here, so the chunk read and the parser cannot disagree about which versions are chunks.
const abw = require('../attest_batch_wire.js');
// The frozen anchor/archive reward heights: the derive flag-day and the fleet-agreed
// mirror-completeness watermark. Recovery-restored rewards claim their ORIGINAL derive
// height from here, so a restored row and a live-derived one carry the same stamp.
const ar = require('../anchor_reward_activation.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { ATTEST_BATCH_CHUNK_ROW_LIMIT } = require('./shared.js');

module.exports = {

    // Build the read-only attestation-response snapshot the VM exposes through
    // xchain.attestation.getResponse(requestId). Scoped to fulfilled requests emitted by
    // THIS contract (the v0 request row's contract_index), visible as-of blockIndex.
    // Returns a SERIALIZABLE snapshot { responses: { [request_id]: { status, payload,
    // providerId, blockIndex, validatorCount } } }; xchain-vm/src/readonly-accessors.js
    // rebuilds the synchronous getResponse accessor from it inside the forked worker
    // (so this returns plain data, not closures, exactly like getContractStakeDataForVM).
    // Only wired into the snapshot at/after the VM_ATTESTATION_GETRESPONSE flag-day; below
    // it execute.js passes attestationData:null and getResponse() returns null.
    //
    // Dedup (#4373): the retry-then-ok lifecycle can write MULTIPLE v1 rows per request_id
    // (a retryable no_quorum/provider_error round, then the terminal ok). getResponse must
    // surface the response the callback fired on - the terminal ok - so we select only
    // response_status='ok' rows and, on the (defensive) chance more than one exists, keep
    // the EARLIEST by (block_index, action_index). A fulfilled request has exactly one ok
    // in practice, but the tie-break keeps the choice deterministic regardless.
    //
    // Determinism + bounding: only 'valid' rows with block_index <= blockIndex are visible
    // (an ok response that lands in a later block, or is rolled back, is not observable
    // as-of this block). The result is capped at the most-recent GETRESPONSE_MAX fulfilled
    // requests, ordered newest-first, so the surviving set is identical on every node; a
    // contract reading a request older than the cap deterministically sees null on all
    // nodes (the callback already delivered that response at fulfillment time, and a
    // contract needing it long-term persists it to its own state).
    async getAttestationDataForVM(contractIndex, blockIndex){
        // Most-recent-N cap. Keeps the per-EXECUTE snapshot bounded (each payload can be
        // up to the provider's max_response_bytes) while covering the re-consult-recent
        // use case; the value is consensus-critical (it decides snapshot membership), so
        // a change is a flag-day, not a config knob.
        const GETRESPONSE_MAX = 100;
        let responses = {};
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { responses };
        let query = `SELECT v1.request_id, v1.provider_id, v1.response_payload, v1.response_status,
                            v1.validator_signatures, v1.block_index, v1.action_index
                     FROM attests v1
                         INNER JOIN attests v0 ON (v0.request_id = v1.request_id AND v0.version = 0)
                     WHERE v1.version = 1
                       AND v1.response_status = 'ok'
                       AND v1.status_id = ?
                       AND v1.block_index <= ?
                       AND v0.contract_index = ?
                       AND v0.status_id = ?
                     ORDER BY v1.block_index DESC, v1.action_index DESC
                     LIMIT ?`;
        let rows = await this.doQuery(query, [valid_id, Number(blockIndex), Number(contractIndex), valid_id, GETRESPONSE_MAX]);
        // rid -> chosen row's (block, action), so the earliest-ok tie-break is explicit
        // and does not rely on the SQL ordering alone.
        let chosen = {};
        for(let row of rows){
            let rid = String(row.request_id || '').toLowerCase();
            if(!rid) continue;
            let cb = Number(row.block_index);
            let ca = Number(row.action_index);
            let prev = chosen[rid];
            if(prev !== undefined && !(cb < prev.block || (cb === prev.block && ca < prev.action)))
                continue;
            // validatorCount = number of verified federation signatures inlined on the
            // response row (JSON array); a malformed/absent column reads as 0.
            let vc = 0;
            if(row.validator_signatures){
                try { let arr = JSON.parse(row.validator_signatures); if(Array.isArray(arr)) vc = arr.length; }
                catch(e){ vc = 0; }
            }
            responses[rid] = {
                status:         String(row.response_status),
                payload:        row.response_payload != null ? String(row.response_payload) : '',
                providerId:     String(row.provider_id || ''),
                blockIndex:     cb,
                validatorCount: vc
            };
            chosen[rid] = { block: cb, action: ca };
        }
        return { responses };
    },

    /*
     * External attestation framework - see specs/2026-05-24_external-attestation-framework.md
     */

    // Create/Update an ATTEST v0 (request) row in the consolidated `attests` table
    async createAttestationRequest(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let fee_payer_id     = await this.getAddressId(data['FEE_PAYER']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let contract_index   = data['CONTRACT_INDEX'];
        let provider_id      = data['PROVIDER_ID'];
        let payload          = data['REQUEST_PAYLOAD'] || null;
        let callback_method  = data['CALLBACK_METHOD'];
        let callback_params  = data['CALLBACK_PARAMS'] || null;
        let redundancy       = Number(data['REDUNDANCY']) || 0;
        let deadline_block   = data['DEADLINE_BLOCK'] || 0;
        let gas_escrow       = data['GAS_ESCROW'] || '0';
        let request_status   = data['REQUEST_STATUS'] || 'pending';
        let block_index      = data['BLOCK_INDEX'];
        // Optional request fee (E1): tick resolved to an id (NULL = feeless)
        let fee_tick_id      = !this.util.isNull(data['FEE_TICK']) ? await this.createTicker(data['FEE_TICK']) : null;
        let fee_amount       = !this.util.isNull(data['FEE_AMOUNT']) ? String(data['FEE_AMOUNT']) : null;
        // ATT-RECOMP-1: the ordered responsible-set pubkeys pinned as-of block_index at request
        // time (JSON array string), so the reorg missed_count recompute reads the historical set
        // verbatim instead of re-deriving it against the CURRENT mutable stakes.amount. NULL for
        // rejected/feeless-legacy rows (the recompute falls back to the live re-derive).
        let responsible_set  = !this.util.isNull(data['RESPONSIBLE_SET_JSON']) ? String(data['RESPONSIBLE_SET_JSON']) : null;
        // Cross-chain relay: NULL on every native single-chain request, so a
        // pre-activation replay writes exactly the columns it wrote before. Set to the
        // origin chain on a relay-eligible LTC/DOGE v0 (what the hub's relay poll keys
        // on) and on the BTC v3 row that materializes it (where it also suppresses the
        // local callback, since the contract is not on BTC).
        let origin_chain     = !this.util.isNull(data['ORIGIN_CHAIN']) ? String(data['ORIGIN_CHAIN']) : null;
        let origin_action    = !this.util.isNull(data['ORIGIN_ACTION_INDEX']) ? Number(data['ORIGIN_ACTION_INDEX']) : null;

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=0, request_id=?, contract_index=?, fee_payer_id=?, provider_id=?, payload=?,
                        callback_method=?, callback_params_json=?, redundancy=?, deadline_block=?,
                        gas_escrow=?, fee_tick_id=?, fee_amount=?, responsible_set_json=?,
                        origin_chain=?, origin_action_index=?, request_status=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index, action_index
            ]);
        } else {
            // v0 single-request integrity. The (request_id, version) index was relaxed to
            // non-unique so multiple v1 response rounds can coexist (#4373); that also drops
            // the DB-level guard against a second v0 for one request_id. The request_id preimage
            // is collision-free, so this should never fire, but guard deterministically against
            // an un-threaded emission path: keep the first v0 row canonical and skip the
            // duplicate rather than splitting one request across two rows.
            let priorV0 = await this.doQuery("SELECT action_index FROM attests WHERE request_id=? AND version=0 LIMIT 1", [request_id]);
            if(priorV0.length > 0){
                console.warn('createAttestationRequest: duplicate v0 for request_id=' + request_id +
                             ' (keeping action_index=' + priorV0[0].action_index + ', skipping ' + action_index + ')');
                return;
            }
            query = `INSERT INTO attests
                        (action_index, version, request_id, contract_index, fee_payer_id, provider_id, payload,
                         callback_method, callback_params_json, redundancy, deadline_block,
                         gas_escrow, fee_tick_id, fee_amount, responsible_set_json,
                         origin_chain, origin_action_index, request_status, status_id, block_index)
                    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index
            ]);
        }
    },

    // Create/Update an ATTEST v1 (response) row in the consolidated `attests` table.
    // The verified federation signatures ride in the validator_signatures JSON
    // column (data['VALIDATOR_SIGNATURES'] - a JSON array string, or null) rather
    // than in a separate child table. Keyed on action_index: the retry-then-ok
    // lifecycle (#4373) produces MULTIPLE v1 rows per request_id (one per PBFT round,
    // a retryable round then the terminal ok), each its own immutable action-indexed
    // row, so (request_id, version) is intentionally NOT unique.
    async createAttestationResponse(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let provider_id      = data['PROVIDER_ID'];
        let response_hash    = String(data['RESPONSE_HASH'] || '').toLowerCase();
        let response_payload = data['RESPONSE_PAYLOAD'] || null;
        let response_status  = data['RESPONSE_STATUS'];
        let meta             = data['META'] || null;
        let signatures       = data['VALIDATOR_SIGNATURES'] || null;
        let block_index      = data['BLOCK_INDEX'];

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=1, request_id=?, provider_id=?, response_hash=?, response_payload=?,
                        response_status=?, meta=?, validator_signatures=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index, action_index
            ]);
        } else {
            query = `INSERT INTO attests
                        (action_index, version, request_id, provider_id, response_hash, response_payload,
                         response_status, meta, validator_signatures, status_id, block_index)
                    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index
            ]);
        }
    },

    // Create the audit row for an ATTEST v5/v6 batch action in the consolidated `attests`
    // table. Keyed on action_index like every other row there.
    //
    // A batch action carries no request, no provider and no response body, so this writes
    // only the four columns that mean something for it:
    //   version      5 (head) or 6 (continuation)
    //   request_id   THE BATCH KEY. The column's role is "correlation key across versions",
    //                and for the batch pair that is exactly what this is: a continuation
    //                names its head by this value and nothing else. Empty on a wire so
    //                malformed that no key could be derived from it.
    //   provider_id  '' - NOT NULL with no provider to name, the same reason a rejected
    //                ATTEST v4 with no matching request stores the empty string.
    //   status_id    the batch verdict, which is what a replay re-derives.
    //
    // The wire BODY is deliberately not stored: absorption happens at parse time from the
    // action's own params, so persisting the compressed bytes would duplicate chain data
    // this table has no reader for. A cross-action chunk store, which head-side reassembly
    // of a MULTI-chunk batch needs, is separate work: it wants its own columns on this
    // table rather than a reinterpretation of these.
    async createAttestationBatchAction(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let version      = Number(data['VERSION']);
        let batch_key    = String(data['REQUEST_ID'] || '').toLowerCase();
        let block_index  = data['BLOCK_INDEX'];

        // The chunk-table half of the row: this action's slot, its body slice, and (on a
        // head) the window header the completing action reassembles against. Absent on a
        // structurally broken wire, where nothing was parsed to store.
        let num = (v) => (v != null && v !== '') ? Number(v) : null;
        let str = (v) => (v != null && v !== '') ? String(v)  : null;
        let window_start     = num(data['WINDOW_START']);
        let window_end       = num(data['WINDOW_END']);
        let row_count        = num(data['ROW_COUNT']);
        let btc_block_height = num(data['BTC_BLOCK_HEIGHT']);
        let batch_crc32      = str(data['BATCH_CRC32']);
        let total_chunks     = num(data['TOTAL_CHUNKS']);
        let chunk_index      = num(data['CHUNK_INDEX']);
        let chunk_b64        = str(data['CHUNK_B64']);

        let results = await this.doQuery("SELECT action_index FROM attests WHERE action_index=? LIMIT 1", [action_index]);
        if(results.length > 0){
            await this.doQuery(`UPDATE attests SET
                                    version=?, request_id=?, provider_id='', status_id=?, block_index=?,
                                    batch_window_start=?, batch_window_end=?, batch_row_count=?,
                                    batch_btc_block_height=?, batch_crc32=?, batch_total_chunks=?,
                                    batch_chunk_index=?, batch_chunk_b64=?
                                WHERE action_index=?`,
                [version, batch_key, status_id, block_index,
                 window_start, window_end, row_count, btc_block_height,
                 batch_crc32, total_chunks, chunk_index, chunk_b64, action_index]);
        } else {
            await this.doQuery(`INSERT INTO attests
                                    (action_index, version, request_id, provider_id, status_id, block_index,
                                     batch_window_start, batch_window_end, batch_row_count,
                                     batch_btc_block_height, batch_crc32, batch_total_chunks,
                                     batch_chunk_index, batch_chunk_b64)
                                VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [action_index, version, batch_key, status_id, block_index,
                 window_start, window_end, row_count, btc_block_height,
                 batch_crc32, total_chunks, chunk_index, chunk_b64]);
        }
    },

    // The stored chunk table for one ATTEST batch: the v5 head's slot 0 and every v6
    // continuation slot already on chain, under the batch key both file themselves by.
    //
    // Rejected rows are excluded, so a junk wire can neither occupy a slot nor contribute
    // bytes, and an unstamped row (a structurally broken wire, or a row written before
    // these columns existed) is excluded too: it carries no slot, so it is not a chunk.
    // The head row carries the window header as well, which is what lets a continuation
    // landing afterwards rebuild the head it must verify the reassembled body against.
    //
    // `source` is the broadcaster address off actions.source_id, which is the only
    // authenticated identity a chain wire carries and is what binds a slot to a publisher.
    // The key is derived from the window a head declares, so anyone can mint a wire under
    // it and the unscoped set this returns is every publisher's; attest.js partitions it
    // by author (the ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL rule, applied there because that is
    // where the rest of the batch's rules live and are driven).
    //
    // `author`, when supplied, moves that partition INTO the query, exactly as
    // getAnchorChunks takes the archive rail's, and is the only form that can carry a row
    // limit. THE LIMIT BELONGS AFTER THE PARTITION, NEVER BEFORE IT: a batch key is
    // sha256 over the window it names, so anyone can derive it and mint wires under it
    // ahead of the honest publisher, and the order here is slot-major, so a limit taken
    // before the partition is emptied by junk filling the low slots and the honest
    // publisher's own head and chunks fall outside the window. That is the reverse of the
    // archive rail's content-addressed read, where a copy is made from bytes already
    // on-chain and so can never sort ahead of the original it copied. After the partition
    // the bound is free: one publisher's valid rows under one key are their head plus one
    // row per slot (a second head and a refilled slot are both stamped invalid, and this
    // query returns only 'valid'), which the wire geometry ceiling already bounds.
    //
    // ORDER BY slot then action_index makes the head pick and the duplicate resolution
    // deterministic across nodes: within a slot the EARLIEST action wins, matching
    // attestChunkCoverage's own tie-break. Ordering is on consensus-visible columns only,
    // never on a local auto-increment.
    //
    // @param {string} batchKey the 64-hex batch key (attests.request_id on a batch row)
    // @param {string} [author] broadcaster address to scope to; omitted returns every
    //                          publisher's rows unbounded, the legacy shape
    // @returns {Object[]} rows shaped for attest_batch_wire's coverage and reassembly
    async getAttestBatchChunks(batchKey, author){
        let scoped = (author !== undefined && author !== null && String(author).length > 0);
        let query = `SELECT c.action_index, c.version, c.request_id,
                            c.batch_window_start     AS window_start,
                            c.batch_window_end       AS window_end,
                            c.batch_row_count        AS row_count,
                            c.batch_btc_block_height AS btc_block_height,
                            c.batch_crc32            AS batch_crc32,
                            c.batch_total_chunks     AS total_chunks,
                            c.batch_chunk_index      AS chunk_index,
                            c.batch_chunk_b64        AS chunk_b64,
                            cadr.address             AS source
                     FROM attests c
                     JOIN index_statuses s ON s.id = c.status_id
                     LEFT JOIN actions         cact ON cact.action_index = c.action_index
                     LEFT JOIN index_addresses cadr ON cadr.id           = cact.source_id
                     WHERE c.request_id = ?
                       AND c.version IN (${abw.ATTEST_BATCH_HEAD_VERSION}, ${abw.ATTEST_BATCH_CONTINUATION_VERSION})
                       AND c.batch_chunk_index IS NOT NULL
                       AND s.status = 'valid'` +
                     (scoped ? ` AND cadr.address = ?` : ``) + `
                     ORDER BY c.batch_chunk_index ASC, c.action_index ASC` +
                     (scoped ? ` LIMIT ${ATTEST_BATCH_CHUNK_ROW_LIMIT}` : ``);
        let params = [String(batchKey || '').toLowerCase()];
        if(scoped) params.push(String(author));
        return await this.doQuery(query, params);
    },

    // Stamp a verdict on a batch HEAD row after the fact, the ANCHOR archive rule
    // (setAnchorArchiveStatus): when a continuation completes the coverage and the
    // reassembled body fails, the failure belongs to the batch, and the batch's verdict
    // lives on its head. The completing chunk's own bytes were well formed and its row
    // stays valid, so one bad batch never re-judges an honest wire.
    async setAttestBatchStatus(actionIndex, status){
        let status_id = await this.createStatus(status);
        await this.doQuery("UPDATE attests SET status_id = ? WHERE action_index = ?", [status_id, actionIndex]);
    },

    // Increment a counter column on attest_validator_stats. Upserts the
    // (validator_pubkey, provider_id) row on first sight. `field` is whitelisted
    // to the counter columns so callers can't inject arbitrary SQL.
    //
    // Reorg note: the table is append-monotone (counters only), so the standard
    // `DELETE WHERE block_index >= ?` pattern can't roll it back - a row's
    // earlier, surviving increments live alongside the orphaned ones. Rollback
    // therefore recomputes affected pairs from the surviving ledger rather than
    // deleting by index: Rollback._recomputeAttestationValidatorStats() drops the
    // rows last touched in the orphaned range and rebuilds them from surviving
    // signatures (fulfilled) + expired requests (missed), matching a from-genesis
    // replay. This keeps the counters consensus-safe across reorgs so Phase 4
    // slashing can consume them. See src/rollback.js.
    //
    // Spec: external attestation framework §10 (validator stat accounting).
    async incrementAttestationValidatorStat(validatorPubkey, providerId, field, blockIndex){
        const allowed = { fulfilled_count: 1, missed_count: 1, slashed_count: 1 };
        if(!allowed[field]) throw new Error('incrementAttestationValidatorStat: unsupported field ' + field);
        let pk  = String(validatorPubkey || '').toLowerCase();
        let pid = String(providerId || '');
        if(!pk || !pid) return;
        let query = `INSERT INTO attest_validator_stats
                        (validator_pubkey, provider_id, ${field}, last_updated_block)
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE
                        ${field} = ${field} + 1,
                        last_updated_block = VALUES(last_updated_block)`;
        await this.doQuery(query, [pk, pid, blockIndex || 0]);
    },

    // Look up an ATTEST v0 (request) row by its request_id (64-hex hash)
    async getAttestationRequestById(requestId){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.request_id = ? AND ar.version = 0
                     ORDER BY ar.action_index ASC
                     LIMIT 1`;
        let rows = await this.doQuery(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Per-block ATTEST v0 admission counts, for the spec §11.1 caps
    // (attest_request_cap_activation.js). Returns { total, byContract }: admitted v0
    // requests EARLIER IN THIS BLOCK, and how many of those came from `contractIndex`.
    //
    // Deterministic by construction, which is the whole requirement for a consensus
    // gate. Every node processes a block's actions in action_index order inside one
    // transaction, so `action_index < ?` selects exactly the earlier admissions of this
    // block and nothing else; action_index is unique, so the order is total and every
    // node sees the same prefix at the same action. A from-genesis replay reproduces it.
    //
    // 'rejected' rows are excluded for the same reason the relay lookup below excludes
    // them: a refused request never escrowed a fee and was never served, so it consumed
    // no slot. Counting them would let one malformed request burn capacity, which turns
    // an anti-abuse cap into an abuse vector.
    //
    // doQueryStrict, not doQuery: a swallowed DB fault here would silently return zero
    // counts and admit past the cap. A throw rolls the block back and retries it, which
    // is the correct answer to a DB fault on a consensus path.
    async getAttestationAdmissionCounts(blockIndex, actionIndex, contractIndex){
        let query = `SELECT COUNT(*) AS total,
                            COALESCE(SUM(CASE WHEN contract_index = ? THEN 1 ELSE 0 END), 0) AS by_contract
                     FROM attests
                     WHERE version = 0
                       AND block_index = ?
                       AND action_index < ?
                       AND request_status <> 'rejected'`;
        let rows = await this.doQueryStrict(query, [contractIndex, Number(blockIndex), Number(actionIndex)]);
        let row  = (rows && rows.length > 0) ? rows[0] : {};
        return {
            total:      Number(row.total || 0),
            byContract: Number(row.by_contract || 0)
        };
    },

    // Cross-chain relay: look up the ATTEST v0 row that already materialized a given relay
    // identity (origin_chain, origin_action_index) on this chain. This is the exactly-once
    // key the v3 admission guard needs and request_id cannot supply: request_id derives
    // from the ORIGIN tx_hash, so a reorg that re-emits the same origin action from a
    // different transaction yields a new request_id for the same identity.
    //
    // 'rejected' rows are excluded deliberately. A rejected row never enters the pending
    // pool, is never fulfilled and spends no fee, so it consumed no exactly-once slot;
    // counting it would let anyone permanently block a legitimate materialization by
    // broadcasting one malformed v3 naming the same origin action. ORDER BY action_index
    // keeps the FIRST materialization canonical on every node.
    //
    // doQueryStrict, not doQuery, and the difference is a fork. This read is a CONSENSUS
    // INPUT: null here is what admits the v3 and writes a 'valid'/'pending' row, so a
    // swallowed query error collapsing to [] is indistinguishable from "no prior
    // materialization" and makes one faulting node materialize a duplicate BTC request
    // every other node rejected - the M-17 shape doQueryStrict was added for. Block
    // processing already holds a transaction, under which doQuery re-throws anyway, so
    // this is not a behavior flip on the live path; it is the guarantee stated
    // unconditionally, for the replay/genesis/synthetic entry points that reach the same
    // handler outside one. A throw rolls the block back and retries it, which is the
    // correct answer to a DB fault and is NOT the DB-constraint throw the schema comment
    // rules out: that one fires on legitimate DATA and would halt every node in turn.
    async getRelayRequestByOrigin(originChain, originActionIndex){
        let query = `SELECT action_index, request_id, request_status
                     FROM attests
                     WHERE origin_chain = ? AND origin_action_index = ?
                       AND version = 0 AND request_status <> 'rejected'
                     ORDER BY action_index ASC
                     LIMIT 1`;
        let rows = await this.doQueryStrict(query, [String(originChain || ''), Number(originActionIndex)]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Cross-chain relay: has THIS request_id already been ADMITTED on this chain?
    //
    // Narrow by design, and deliberately not a change to getAttestationRequestById
    // above. That shared lookup answers "show me the request row for this id" and
    // four consensus paths depend on it seeing every stored row, rejected verdicts
    // included (v1 response resolution, v2 expiry, v4 relay response, slash round
    // lookup). Only the v3 admission guard needs the narrower question, so only the
    // v3 admission guard gets this query.
    //
    // 'rejected' rows are excluded for the same reason getRelayRequestByOrigin
    // excludes them, and the omission was exploitable in exactly the shape that
    // sibling was written to prevent. request_id arrives on the wire and is derivable
    // in public from the origin chain's v0, so anyone can watch an origin chain, take
    // the id of a request the federation is about to relay, and broadcast a
    // deliberately malformed v3 naming it. The malformed one is rejected but still
    // stored, and a guard that counts stored rows then reads that audit row as "this
    // id is taken" and refuses the federation's real relay forever. One transaction
    // fee, one permanently unservable request. A rejected row escrowed nothing, was
    // never pending and was never served, so it consumed no materialization.
    //
    // ORDER BY action_index keeps the FIRST admission canonical on every node, and
    // doQueryStrict for the reason spelled out on getRelayRequestByOrigin: null here
    // is what ADMITS the v3, so a swallowed query error collapsing to [] would make
    // one faulting node materialize a request every other node refused.
    async getRelayRequestById(requestId){
        let query = `SELECT action_index, request_id, request_status
                     FROM attests
                     WHERE request_id = ? AND version = 0
                       AND request_status <> 'rejected'
                     ORDER BY action_index ASC
                     LIMIT 1`;
        let rows = await this.doQueryStrict(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Update the request_status field on an ATTEST v0 (request) row
    // resolvedBlock anchors a TERMINAL flip ('fulfilled'/'errored'/'expired') to the
    // block that caused it, so the rollback pass can reset the surviving request row
    // when that block reorgs (covers the v1-response AND v2-expiry paths - the old
    // v1-only self-join reset left a reorged expiry stuck terminal, and replay then
    // skipped re-synthesizing the v2 row: reorged-node vs fresh-sync divergence).
    async updateAttestationRequestStatus(requestId, newStatus, resolvedBlock){
        let query = `UPDATE attests
                     SET request_status = ?, resolved_block = ?
                     WHERE request_id = ? AND version = 0`;
        await this.doQuery(query, [newStatus, (resolvedBlock != null ? resolvedBlock : null),
                                   String(requestId || '').toLowerCase()]);
    },

    // List ATTEST v0 (request) rows currently in 'pending' status, ordered by
    // creation. xchain-hub's AttestationRound polls this to discover work.
    // Optional providerId filter lets a validator only see requests for
    // providers it serves.
    async getPendingAttestationRequests(providerId, limit, cursor){
        let where = "request_status = 'pending'";
        let args  = [];
        if(providerId){
            where += ' AND provider_id = ?';
            args.push(String(providerId));
        }
        where += ' AND version = 0';
        // Keyset/cursor pagination. When the caller passes the last
        // (block_index, action_index) it has already consumed, return only rows
        // strictly after it. This lets a poller page through more than `limit`
        // pending requests across successive calls instead of being permanently
        // pinned to the oldest `limit` rows - without a cursor, a backlog larger
        // than `limit` starves every newer request until the oldest ones drain.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (block_index > ? OR (block_index = ? AND action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floor + hard-cap here at the interpolation site so the row count is
        // always a bounded integer regardless of caller: a fractional limit
        // (e.g. 100.5) would produce `LIMIT 100.5`, a MariaDB syntax error that
        // throws and fails the whole attestation-work poll, and an unclamped large
        // integer would be an unbounded scan. The RPC layer also range-clamps, but
        // this method owns the SQL so it enforces the invariant for every caller.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT action_index, request_id, contract_index, fee_payer_id, provider_id,
                            payload, callback_method, callback_params_json,
                            redundancy, deadline_block, gas_escrow, fee_tick_id, fee_amount,
                            origin_chain, origin_action_index,
                            request_status, status_id, block_index
                     FROM attests
                     WHERE ` + where + `
                     ORDER BY block_index ASC, action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // Convert BigInt columns to Number so the express JSON serializer
        // doesn't throw `TypeError: Do not know how to serialize a BigInt`.
        // Bounded chain values (block heights, action indexes) stay well
        // within Number.MAX_SAFE_INTEGER on a regtest or production network.
        return rows.map(r => ({
            ...r,
            action_index:   typeof r.action_index   === 'bigint' ? Number(r.action_index)   : r.action_index,
            contract_index: typeof r.contract_index === 'bigint' ? Number(r.contract_index) : r.contract_index,
            fee_payer_id:   typeof r.fee_payer_id   === 'bigint' ? Number(r.fee_payer_id)   : r.fee_payer_id,
            fee_tick_id:    typeof r.fee_tick_id    === 'bigint' ? Number(r.fee_tick_id)    : r.fee_tick_id,
            deadline_block: typeof r.deadline_block === 'bigint' ? Number(r.deadline_block) : r.deadline_block,
            status_id:      typeof r.status_id      === 'bigint' ? Number(r.status_id)      : r.status_id,
            // NULL on every native request. Non-null marks the row as one leg of a
            // cross-chain relay, which is what the hub's relay driver filters on.
            origin_action_index: typeof r.origin_action_index === 'bigint' ? Number(r.origin_action_index) : r.origin_action_index,
            block_index:    typeof r.block_index    === 'bigint' ? Number(r.block_index)    : r.block_index
        }));
    },

    // Cross-chain relay: every ATTEST v0 request this chain holds only as a MATERIALIZED
    // relay leg, i.e. whose row carries an origin_chain that is some OTHER chain, with
    // its terminal response attached when one exists. On BTC that is exactly the set of
    // v3-materialized requests, at any lifecycle status. The predicate is
    // self-restricting rather than coin-gated: on an ORIGIN chain a relay-eligible
    // row's origin_chain equals that coin, so it never matches and this returns empty.
    //
    // ONE READ, TWO QUESTIONS, and the first is why it is driven by the request rather
    // than the response. xchain-hub's relay driver must not materialize a request that
    // is already on BTC, and its only home-side view was the PENDING queue: a request
    // that had been fulfilled or had expired was no longer pending, so it read as
    // never materialized and the driver would broadcast a second v3, which v3 admission
    // rejects as a duplicate REQUEST_ID after the fee is already spent. Returning the
    // request row whatever its status answers that; the LEFT JOIN answers the second
    // question, which response is owed back to the origin chain as an ATTEST v4.
    //
    // The response join is deliberately narrow. Only the two TERMINAL statuses can
    // relay: the retryable ones (no_quorum / timeout / provider_error) leave the
    // request pending for another round, and relaying one would close an origin
    // request the home chain still intends to fulfill. That, plus the valid-status
    // match, is what makes the join produce AT MOST one response row per request: the
    // retry-then-ok lifecycle writes several v1 rows, but only one can be both valid
    // and terminal, every later one being rejected as 'REQUEST already fulfilled'.
    // The status id is resolved once and compared as an integer so the filter can sit
    // in the ON clause, where a LEFT JOIN needs it, without a third join.
    //
    // response_hash is returned alongside response_payload deliberately: the stored
    // payload is the UTF-8 DECODE of the bytes that were hashed, so a non-UTF-8
    // attested body cannot be re-encoded to the same bytes. The caller compares the
    // two and refuses to relay a body it cannot reproduce (see AttestationRelay).
    async getRelayedAttestationRequests(coin, requestId, limit, cursor){
        let validStatusId = await this.getStatusId('valid');
        let where = `req.version = 0
                       AND req.origin_chain IS NOT NULL
                       AND req.origin_chain <> ?`;
        let args = [validStatusId, String(coin || '')];
        if(requestId){
            where += ' AND req.request_id = ?';
            args.push(String(requestId).toLowerCase());
        }
        // Same keyset cursor contract as getPendingAttestationRequests: the caller pages
        // forward by the last (block_index, action_index) it consumed, so a backlog
        // larger than `limit` does not starve newer rows forever. The cursor is on the
        // REQUEST's pair, which is the ordering, so a caller can page this read with
        // exactly the code it uses for the pending one.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (req.block_index > ? OR (req.block_index = ? AND req.action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floored and hard-capped here, at the interpolation site, for the same reason
        // getPendingAttestationRequests does it: a fractional limit is a MariaDB syntax
        // error and an unclamped one is an unbounded scan, and this method owns the SQL.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT req.action_index, req.block_index, req.request_id, req.provider_id,
                            req.origin_chain, req.origin_action_index, req.request_status,
                            resp.action_index  AS response_action_index,
                            resp.block_index   AS response_block_index,
                            resp.response_hash, resp.response_payload,
                            resp.response_status, resp.meta
                     FROM attests req
                     LEFT JOIN attests resp
                            ON (resp.request_id = req.request_id
                                AND resp.version = 1
                                AND resp.status_id = ?
                                AND resp.response_status IN ('ok','expired'))
                     WHERE ` + where + `
                     ORDER BY req.block_index ASC, req.action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // BigInt -> Number for the express JSON serializer, as in
        // getPendingAttestationRequests; every column here is a bounded chain value.
        return rows.map(r => ({
            ...r,
            action_index:          typeof r.action_index          === 'bigint' ? Number(r.action_index)          : r.action_index,
            block_index:           typeof r.block_index           === 'bigint' ? Number(r.block_index)           : r.block_index,
            response_action_index: typeof r.response_action_index === 'bigint' ? Number(r.response_action_index) : r.response_action_index,
            response_block_index:  typeof r.response_block_index  === 'bigint' ? Number(r.response_block_index)  : r.response_block_index,
            origin_action_index:   typeof r.origin_action_index   === 'bigint' ? Number(r.origin_action_index)   : r.origin_action_index
        }));
    },

    // Find ATTEST v0 (request) rows whose deadline_block has passed without a response.
    // Returns full rows so the expiry handler doesn't have to refetch.
    //
    // CAPPED per block at ATTEST_MAX_EXPIRIES_PER_BLOCK. Unbounded, one
    // block could inherit an arbitrary backlog of expiries, each of which synthesizes
    // an ATTEST v2 and fires a contract callback, so block processing time became a
    // function of how many deadlines happened to coincide: an attacker picks that
    // number by batching requests on a common deadline.
    //
    // The overflow is NOT dropped, it carries to the next block. That is safe only
    // because the ORDER BY is a TOTAL order: deadline_block is not unique, but
    // action_index is, so (deadline_block ASC, action_index ASC) has exactly one
    // valid ordering and every node takes the same prefix. A cap over a partial or
    // planner-dependent order would let two nodes select different subsets and fork,
    // which is why the ordering is spelled out here rather than left implicit.
    async getExpiredAttestationRequests(blockIndex, limit = ATTEST_MAX_EXPIRIES_PER_BLOCK){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block < ?
                     ORDER BY ar.deadline_block ASC, ar.action_index ASC
                     LIMIT ?`;
        return await this.doQuery(query, [blockIndex, limit]);
    },

    // ATTEST v0 (request) rows that a hub-mirrored response could still bind to at
    // `blockIndex`: pending, and not past their deadline. This is the LOCAL half of
    // the mirror applier's applicability read (the response-mirror design §4.1); the
    // mirror half is getMirroredAttestationResponses below and the predicate that
    // joins them is utility.selectApplicableAttestationResponses.
    //
    // THE SCAN IS DRIVEN FROM THIS SIDE ON PURPOSE. The mirror table grows without
    // bound and its rows carry hub-authored columns; scanning it by
    // request_block_index (its natural window) would make the set of rows an indexer
    // even CONSIDERS depend on a field no signature covers, so two indexers following
    // two hubs could consider different sets. Every column read here is local chain
    // state, and a request leaves this set the moment it resolves or its deadline
    // passes, which is what bounds the scan without a hub-supplied bound.
    //
    // `deadline_block >= ?` is the applier's half of §4.1's `B <= deadline_block`: a
    // row whose first satisfying block is past the deadline is never selected here,
    // the expiry sweep (deadline_block < B, one step later in the same block) flips
    // the request to 'expired', and the expired callback stands (AT3). The predicate
    // is re-stated in the selector, which is where it is tested; this bound only
    // keeps the read from returning rows the selector must then discard.
    //
    // ORDER BY (block_index, action_index) is the §4.1 applier order, read from the
    // LOCAL request rows and never from the mirror row or from a request_id
    // collation, so every node applies a block's responses in one order.
    //
    // PAGED, and the page is NOT consensus. `limit` and `after` walk that same order in
    // windows so the applier can stop once it has filled its per-block cap instead of
    // dragging every pending request (and then every one of their mirror rows) into
    // memory first. Two nodes paging at different sizes still select the same rows: the
    // order is TOTAL (action_index is unique), the pages are disjoint consecutive slices
    // of it, and the caller concatenates them in page order, so the sequence it sees is
    // the same sequence the unpaged read produced. The keyset carry is (block_index,
    // action_index) rather than an offset because an offset re-reads a shifted window
    // when a row resolves between pages.
    //
    // @param {number} blockIndex the block being processed
    // @param {number} [limit] page size; omitted reads the whole set, the legacy shape
    // @param {Object} [after] exclusive keyset cursor {block_index, action_index}
    async getAttestationRequestsAwaitingMirrorResponse(blockIndex, limit, after){
        let params = [Number(blockIndex)];
        let keyset = '';
        if(after){
            keyset = ` AND (ar.block_index > ? OR (ar.block_index = ? AND ar.action_index > ?))`;
            params.push(Number(after.block_index), Number(after.block_index), Number(after.action_index));
        }
        let page = '';
        if(limit !== undefined && limit !== null){
            page = ` LIMIT ?`;
            params.push(Number(limit));
        }
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block >= ?` + keyset + `
                     ORDER BY ar.block_index ASC, ar.action_index ASC` + page;
        return await this.doQuery(query, params);
    },

    // The hub-mirrored finalized responses for a given set of request ids whose SIGNED
    // effective_time has been reached at `blockTime`. The mirror half of the applier's
    // applicability read (§4.1).
    //
    // Read through _mirrorDb(), which is a SEPARATE connection whenever the indexer
    // follows a remote hub DB, so this cannot be one SQL join against local `attests`
    // (the cross_chain_calls readers above have the same split for the same reason).
    //
    // Only network and effective_time filter here, and both are safe to filter on:
    // network scopes the mirror itself, and effective_time is INSIDE the signed
    // canonical, so no hub can move a row's applying block by editing it without
    // breaking every signature on it. The informational request_block_index /
    // request_action_index columns are deliberately not read.
    //
    // Chunked because the id list is caller-sized; the chunks are re-joined by the
    // caller's own deterministic order, so chunk boundaries cannot be observed.
    //
    // ABOVE THE MIRROR-ADMISSION CONSUMER ACTIVATION at `blockHeight` the time filter takes
    // the C33 form on admit_block_btc (the one column the hub stamps on this table, because
    // attest responses are read by BTC alone), and that column is read back so the selector
    // and the verifier can rebuild the signed map from it. Below the activation the
    // statement is byte for byte the one above, and the column is not named at all.
    async getMirroredAttestationResponses(network, requestIds, blockTime, blockHeight){
        let ids = (requestIds || []).map(id => String(id || '').toLowerCase()).filter(id => id.length > 0);
        if(ids.length === 0) return [];
        let mirror = this._mirrorDb();
        let out    = [];
        const CHUNK = 500;
        let bind      = this._mirrorBindClause(Number(blockTime), blockHeight, null, 'admit_block_btc');
        let admitCols = this._mirrorAdmissionActiveAt(blockHeight) ? ', admit_block_btc' : '';
        for(let i = 0; i < ids.length; i += CHUNK){
            let chunk        = ids.slice(i, i + CHUNK);
            let placeholders = chunk.map(() => '?').join(',');
            // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which
            // never holds a transaction, so doQuery turns a transient DB fault into a missing
            // attestation chunk on this node alone, and the block hashes diverge.
            let rows = await mirror.doQueryStrict(
                `SELECT request_id, provider_id, status, response_payload, response_hash, meta,
                        effective_time, signer_pubkeys, signatures, widen, batch_action_index${admitCols}
                 FROM attestation_responses
                 WHERE network = ? AND ${bind.sql} AND request_id IN (${placeholders})`,
                [String(network || '')].concat(bind.args, chunk));
            for(let row of rows) out.push(row);
        }
        return out;
    },

    // Set callback_execute_action_index on an ATTEST v1 (response) row (after the system EXECUTE is injected)
    async setAttestationResponseCallbackIndex(responseActionIndex, callbackExecuteActionIndex){
        let query = `UPDATE attests
                     SET callback_execute_action_index = ?
                     WHERE action_index = ? AND version = 1`;
        await this.doQuery(query, [callbackExecuteActionIndex, responseActionIndex]);
    },

    // Stamp the ATTEST v5/v6 batch that carried a mirror-applied response's body onto
    // the chain, keyed on the REQUEST id rather than on an action_index.
    //
    // The request id is the only identifier the two sides share. The batch is parsed on
    // the DOGE indexer and names the responses it carries by request_id; the v1 row it
    // links to was minted locally on the BTC indexer at whatever block the mirror row
    // became applicable, so its action_index means nothing to the publisher and cannot
    // be on the wire. Scoped to version = 1 because a request also has a v0 row and the
    // batch describes the response, not the request.
    //
    // Idempotent and unordered: a re-delivered or replayed batch restamps the same
    // value, and a batch that lands before the mirror row was applied simply matches no
    // row yet. That is why the column is nullable and why the coverage watermark, not
    // this write, is what proves a window reached the chain.
    async setAttestationResponseBatchIndex(requestId, batchActionIndex){
        let query = `UPDATE attests
                     SET batch_action_index = ?
                     WHERE request_id = ? AND version = 1`;
        await this.doQuery(query, [batchActionIndex, String(requestId || '').toLowerCase()]);
    },

};
