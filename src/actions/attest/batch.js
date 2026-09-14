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
 * XChain Indexer - ATTEST handler part
 *
 * ATTEST v5/v6: the response batch head and continuation wires, and the stored-row helpers they share.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

// The v5/v6 wire: layout, chunking, caps and reassembly. Pure, and byte-twinned
// into xchain-hub so the publisher that BUILDS a batch and this parser cannot
// disagree about its bytes.
const abw     = require('./attest_batch_wire.js');
const { getLogger } = require('../../observability/index.js');
const { BATCH_CHAIN } = require('./constants.js');

module.exports = {
    // ATTEST v5: the response BATCH head.
    //
    // A window of finalized responses, compressed and chunked, carrying the batch quorum's
    // signature set. It is what makes the hub mirror auditable: every terminal response body
    // lands on chain, so a node that replays the chain rebuilds the mirror table and
    // re-derives every callback without trusting any hub.
    //
    // THE DOGE SIDE VERIFIES THE BATCH QUORUM ONLY, NEVER THE PER-ROW RESPONSIBLE SET, and
    // this is a constraint rather than a shortcut: `computeResponsibleSet` returns [] off
    // BTC by construction (attestation stake is BTC-only) and the stake-weighted gate tests
    // the literal 'BTC', so a DOGE indexer cannot resolve a responsible set at all. Per-row
    // verification therefore happens where the stake actually resolves, on the BTC indexer,
    // through the shared verifier after the hub re-serves the row. A batch that carries a
    // row the BTC side later rejects leaves that row unapplied and inert, exactly as a bad
    // mirror row is.
    //
    // A failing batch is `invalid` identically on every node, with NO partial absorb: the
    // one signature set covers the whole window, so dropping a row changes the signed bytes
    // and fails every signature. A signed batch is atomic exactly as a signed round is.
    //
    // ONE CANONICAL HEAD PER PUBLISHER AND WINDOW. The batch key is derived from the
    // window, so one publisher republishing it (a failover rank, a retry after a stuck
    // broadcast) would otherwise absorb the same window twice and enqueue two hub pushes.
    // The earliest valid head for (batch key, author) is the canonical one and a later one
    // from the same publisher is refused; the pick is by action_index, a total order, so
    // every node picks the same head whatever order the wires arrived in. The scope is the
    // AUTHOR's, never the key's alone, because a key-wide pick would let a junk head
    // squatting a window deny the honest publisher outright.
    async parseBatchHead(params, data, error){

        let wire = await this.batchHeadWire(params, data, error);
        error    = wire.error;

        let assembled = await this.assembleBatchHead(wire.head, wire.mine, error);
        error         = assembled.error;
        let batch     = assembled.batch;
        let head      = wire.head;

        data['REQUEST_ID'] = head && head.ok ? head.batchKey : '';
        data['VERSION']    = abw.ATTEST_BATCH_HEAD_VERSION;
        data['STATUS']     = error || 'valid';
        this.stampBatchColumns(data, head, 0);

        getLogger().info("\t ATTEST v5 : batch=" + String(data['REQUEST_ID']).substring(0,16) + '...' +
                    (head && head.ok ? ' : window=' + head.windowStart + '-' + head.windowEnd +
                                       ' rows=' + head.rowCount +
                                       ' anchor=' + head.btcBlockHeight +
                                       ' chunks=' + head.totalChunks : '') +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAttestationBatchAction(data);

        // Durable transactional outbox, the `price_batch` pattern verbatim: the
        // pending_hub_pushes row is written through the OPEN block transaction so it
        // commits atomically with the action row and rolls back with it. The hub is what
        // turns a parsed batch back into mirror rows every BTC indexer then verifies for
        // itself, so this push is the chain-only rebuild road and not an optimisation.
        if(!error && batch && this.hubClient && this.hubClient.enabled){
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            let payload = this.buildBatchHubPush(batch, data, pushGeneration, data['ACTION_INDEX']);
            let pushId  = await this.indexerDb.enqueueHubPushTx('attest_batch', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'attest_batch', payload });
        }

        await this.mapper.createMappings(data);
    },

    // The head wire itself: its rail, its layout, the network it names, and this
    // publisher's slice of what is already on chain under its key. Returns the parsed
    // head, that slice, and the verdict.
    async batchHeadWire(params, data, error){
        // DOGE-plane guard. Stored as a verdict rather than hard-returned like the relay
        // legs, because a batch is publisher-broadcast on a known rail: one landing on
        // BTC or LTC is a publisher fault worth a visible row, not an unknown version.
        if(!error && String(this.config['COIN']) !== BATCH_CHAIN)
            error = 'invalid: ATTEST v5 (batches ride the ' + BATCH_CHAIN + ' rail)';

        let head = null;
        if(!error){
            head = abw.parseAttestBatchHead(params);
            if(!head.ok) error = head.status;
        }

        // A batch names the network it covers, and the mirror is network-scoped, so a
        // batch for another network must not be absorbed by this one even when both
        // chains are reachable from one operator's stack.
        if(!error && head.network !== String(this.config['NETWORK']))
            error = 'invalid: NETWORK (batch declares ' + head.network + ')';

        // Everything already on chain under this key, and the slice of it that is this
        // publisher's. The read happens even for a single-wire batch, because the
        // duplicate-head test below needs it whatever the geometry says.
        let author = String(data['SOURCE'] || '');
        let mine   = [];
        if(!error){
            // Scoped in the QUERY, not only here: the row limit inside it is only safe
            // after the author partition, because a batch key is a hash over the window it
            // names, so anyone can derive it and file wires under it ahead of the honest
            // publisher. The JS filter stays as a harmless second pass.
            mine = this.authoredBy(await this.indexerDb.getAttestBatchChunks(head.batchKey, author), author);
            if(this.canonicalBatchHead(mine))
                error = 'invalid: BATCH_KEY (this publisher already has a head for the window)';
        }

        return { head, mine, error };
    },

    // Reassembly and the batch quorum, the two judgements a head can only reach once
    // every chunk it names is on chain.
    async assembleBatchHead(head, mine, error){
        // Reassembly, then the quorum. A multi-chunk batch is absorbed only once its
        // continuations are on chain; until then the head is a structurally sound action
        // that has delivered nothing, which is the ANCHOR archive head's behaviour and for
        // the same reason (a head can legitimately land before its chunks). When the head
        // lands LAST it reassembles here, against the chunks already stored, so the batch
        // absorbs exactly once whichever order the wires arrive in.
        let batch = null;
        if(!error){
            let stored = (head.totalChunks === 1) ? [] : mine;
            let assembled = abw.reassembleAttestBatch(head, stored);
            if(assembled.ok) batch = assembled.batch;
            // Incomplete coverage is the ONE failure that is not a verdict: the missing
            // chunks may still be mined. Every other one is the batch's, and is recorded
            // identically on every node from the same bytes.
            else if(assembled.reason !== abw.ATTEST_BATCH_FAIL_REASONS.COVERAGE) error = assembled.status;
        }

        if(!error && batch){
            let quorum = await this.verifyBatchQuorum(batch);
            if(!quorum.ok) error = quorum.error;
        }

        return { batch, error };
    },

    // ATTEST v6: a batch continuation chunk.
    //
    // Carries one slice of the head's compressed body and nothing else: no window header,
    // no signatures. The head owns the VERDICT on the batch, so a continuation's own status
    // only ever reports whether ITS bytes are well formed, and a batch that fails when this
    // chunk completes it is stamped on the head instead.
    //
    // The chunk that completes the coverage DOES absorb, because it is the moment the whole
    // window is finally on chain, and it is the same moment on every node.
    //
    // A SLOT BELONGS TO THE PUBLISHER WHOSE BATCH IT IS. Every read here is scoped to this
    // wire's own author, so a continuation joins its own publisher's head and no other, and
    // the duplicate-slot guard counts only that publisher's slots. A chunk broadcast by
    // anyone else is the chunk of its own batch: it can neither occupy a slot in this one
    // nor contribute bytes to its reassembly. Without that scope the first wire into a slot
    // owned it, so a junk chunk denied the window and a well-formed one for another
    // encoding forced the honest head `invalid`.
    async parseBatchContinuation(params, data, error){

        if(!error && String(this.config['COIN']) !== BATCH_CHAIN)
            error = 'invalid: ATTEST v6 (batches ride the ' + BATCH_CHAIN + ' rail)';

        let chunk = null;
        if(!error){
            chunk = abw.parseAttestBatchContinuation(params);
            if(!chunk.ok) error = chunk.status;
        }

        // One read serves all three things this handler needs from the batch's stored rows:
        // the head to verify against, the geometry to agree with, and the slots already
        // taken. Rejected rows never appear in it, so junk neither occupies a slot nor
        // contributes bytes, and the author partition makes the rest this publisher's own.
        let stored = [], headRow = null;
        if(!error){
            let chunkAuthor = String(data['SOURCE'] || '');
            stored  = this.authoredBy(await this.indexerDb.getAttestBatchChunks(chunk.batchKey, chunkAuthor),
                                       chunkAuthor);
            headRow = this.canonicalBatchHead(stored);
        }

        // Geometry must agree with the head that owns the batch. Both fields are signed
        // into neither wire, so this is not a security check: it stops two DIFFERENT
        // encodings of one window (a republish at a different chunk size, say) from
        // interleaving into a body no publisher ever produced.
        if(!error && headRow && Number(headRow.total_chunks) !== chunk.totalChunks)
            error = 'invalid: TOTAL_CHUNKS (does not match the batch head)';
        if(!error && headRow && String(headRow.batch_crc32) !== chunk.batchCrc32)
            error = 'invalid: BATCH_CRC32 (does not match the batch head)';

        // Duplicate-slot guard, the ANCHOR continuation's: a filled slot cannot be refilled,
        // which is what makes a replayed chunk inert instead of a second absorption.
        if(!error && stored.some(r => Number(r.version) === abw.ATTEST_BATCH_CONTINUATION_VERSION &&
                                      Number(r.chunk_index) === chunk.chunkIndex))
            error = 'invalid: CHUNK_INDEX (duplicate)';

        data['REQUEST_ID'] = chunk && chunk.ok ? chunk.batchKey : '';
        data['VERSION']    = abw.ATTEST_BATCH_CONTINUATION_VERSION;
        data['STATUS']     = error || 'valid';
        this.stampBatchColumns(data, chunk, chunk && chunk.ok ? chunk.chunkIndex : null);

        getLogger().info("\t ATTEST v6 : batch=" + String(data['REQUEST_ID']).substring(0,16) + '...' +
                    (chunk && chunk.ok ? ' : chunk=' + chunk.chunkIndex + '/' + chunk.totalChunks : '') +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAttestationBatchAction(data);

        if(!error && headRow)
            await this.absorbCompletedBatch(headRow, stored, chunk, data);

        await this.mapper.createMappings(data);
    },

    // Persist the chunk-table half of a batch action: this wire's slot, its body slice and,
    // on a head, the window header. The header is stored because it is the INPUT to a later
    // reassembly: a continuation landing after the head has no other way to rebuild the head
    // it must verify the assembled body against.
    //
    // @param {Object} data the landing action
    // @param {Object} parsed the parsed head or continuation (null/failed leaves every column NULL)
    // @param {number} chunkIndex this wire's slot: 0 for a head, its own index for a continuation
    stampBatchColumns(data, parsed, chunkIndex){
        if(!parsed || parsed.ok !== true) return;
        data['BATCH_CRC32']  = parsed.batchCrc32;
        data['TOTAL_CHUNKS'] = parsed.totalChunks;
        data['CHUNK_INDEX']  = chunkIndex;
        data['CHUNK_B64']    = parsed.chunkB64;
        if(chunkIndex !== 0) return;
        data['WINDOW_START']     = parsed.windowStart;
        data['WINDOW_END']       = parsed.windowEnd;
        data['ROW_COUNT']        = parsed.rowCount;
        data['BTC_BLOCK_HEIGHT'] = parsed.btcBlockHeight;
    },

    // One publisher's slice of everything filed under a batch key.
    //
    // A BATCH'S IDENTITY IS (KEY, AUTHOR), NEVER THE KEY ALONE. The key is derived from
    // the window a head declares, so anyone can mint a wire under it. Without this
    // partition whoever lands a slot first owns it: a junk chunk broadcast ahead of the
    // honest one takes the slot, the duplicate guard then refuses the real chunk and the
    // window is denied outright, and a well-formed chunk of a different encoding joins the
    // reassembly and forces the head `invalid`. With it, a foreign wire is a chunk of its
    // own batch and governs nobody else's slots. It is the anchor archive rail's rule
    // (ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL), applied to the same failure.
    //
    // `source` comes from actions.source_id, the only authenticated identity a chain wire
    // carries. An unresolvable author scopes to NOTHING rather than to everything, which
    // fails closed: such a publisher's multi-chunk batch simply never assembles.
    authoredBy(rows, author){
        let scope = String(author || '');
        if(scope.length === 0) return [];
        return (rows || []).filter(r => String(r.source || '') === scope);
    },

    // The canonical head of one publisher's batch: the earliest valid v5 slot 0 in an
    // already author-partitioned set, or null when that publisher has none on chain.
    //
    // Earliest by action_index, which is a total order, so every node names the same head
    // whatever order the wires arrived in and the pick is independent of the read's own
    // ordering. It is what makes a publisher's second head for a window a duplicate that
    // absorbs nothing rather than a second delivery of one window, and it is the row a
    // continuation authenticates its geometry against.
    canonicalBatchHead(rows){
        let heads = (rows || []).filter(r => Number(r.version) === abw.ATTEST_BATCH_HEAD_VERSION &&
                                             Number(r.chunk_index) === 0);
        if(heads.length === 0) return null;
        return heads.reduce((best, r) => (Number(r.action_index) < Number(best.action_index)) ? r : best);
    },

    // Rebuild the parsed head a stored v5 row came from, so a continuation reassembles
    // through the SAME path the head-side does, byte for byte.
    //
    // The network is this node's own rather than a stored column: a head declaring another
    // network is refused before it is ever recorded valid, and only valid rows reach here,
    // so the two cannot disagree. One network per database is what makes that hold.
    headFromRow(row){
        return {
            ok:             true,
            batchKey:       String(row.request_id),
            network:        String(this.config['NETWORK']),
            windowStart:    Number(row.window_start),
            windowEnd:      Number(row.window_end),
            rowCount:       Number(row.row_count),
            btcBlockHeight: Number(row.btc_block_height),
            batchCrc32:     String(row.batch_crc32),
            totalChunks:    Number(row.total_chunks),
            chunkB64:       String(row.chunk_b64)
        };
    }
};
