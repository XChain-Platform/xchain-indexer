'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ITEM 2729: recovery.js's wrapperCanonical (the XCHECKPOINT string it builds
// for the v1 archive wrapper) had no byte-level drift coverage independent of

// A folded (v3) archive head carries no checkpoint fields; its wrapper signatures
// were produced over the wrapper section's own canonical extended by the archive
// suffix. These tests pin recovery's rebuild of that canonical against
// Anchor.canonical and the section lookup that feeds it.

const assert = require('assert');

const AnchorRecovery = require('../../../bin/recovery.js');
const Anchor          = require('../../../src/actions/anchor/index.js');
const eq              = require('../../../src/consensus/equivocation_header.js');

const SIGS = JSON.stringify([{ pubkey: 'a'.repeat(64), sig: 'b'.repeat(128) }]);

const section = {
    action_index: 9, section_index: 1, version: 3, chain: 'LTC', network: 'mainnet',
    block_index: 2800100, block_hash: 'bh', ledger_hash: 'lh', actions_hash: 'ah',
    contract_hash: 'ch', checkpoint_seq: 11, snapshot_block: 500000,
    state_root: 'ABCD', state_root_version: 1, block_merkle_root: 'EF01', block_merkle_version: 2,
    validator_signatures: SIGS
};
const head = {
    action_index: 9, section_index: 2, version: 3, chain: null, network: 'mainnet',
    snapshot_block: 500010, match_batch_seq: 7, match_count: 3, batch_crc32: 'DEADBEEF',
    total_chunks: 1, validator_signatures: SIGS
};

function liveCanonical(w, h){
    return new Anchor({}).canonical({
        FORMAT: 0, SECTION_INDEX: 1, CHAIN: w.chain, NETWORK: w.network,
        BLOCK_INDEX_CHECKPOINTED: w.block_index, BLOCK_HASH: w.block_hash,
        LEDGER_HASH: w.ledger_hash, ACTIONS_HASH: w.actions_hash, CONTRACT_HASH: w.contract_hash,
        CHECKPOINT_SEQ: w.checkpoint_seq, SNAPSHOT_BLOCK: w.snapshot_block,
        STATE_ROOT: w.state_root, STATE_ROOT_VERSION: w.state_root_version,
        BLOCK_MERKLE_ROOT: w.block_merkle_root, BLOCK_MERKLE_VERSION: w.block_merkle_version,
        FOLD_ARCHIVE: {
            WRAPPER_SECTION_INDEX: 1, MATCH_BATCH_SEQ: h.match_batch_seq, MATCH_COUNT: h.match_count,
            BATCH_CRC32: h.batch_crc32, TOTAL_CHUNKS: h.total_chunks
        }
    });
}

describe('recovery v3 fold wrapper canonical', function(){
    it('matches the frozen section string with the archive suffix and lower-case CRC', function(){
        assert.strictEqual(AnchorRecovery.foldWrapperCanonicalForTest(head, section),
            'XCHECKPOINT|LTC|mainnet|2800100|bh|lh|ah|ch|11|500000|abcd|1|ef01|2|7|3|deadbeef|1');
    });

    it('byte-matches Anchor.canonical for the wrapper section below the equivocation header', function(){
        assert.strictEqual(eq.isEquivHeaderActive(section.snapshot_block, section.network), false);
        assert.strictEqual(AnchorRecovery.foldWrapperCanonicalForTest(head, section), liveCanonical(section, head));
    });

    it('byte-matches Anchor.canonical once the equivocation header is active', function(){
        let at = Object.assign({}, section, { snapshot_block: eq.EQUIV_HEADER_ACTIVATION.mainnet });
        assert.strictEqual(eq.isEquivHeaderActive(at.snapshot_block, at.network), true);
        let actual = AnchorRecovery.foldWrapperCanonicalForTest(head, at);
        assert.strictEqual(actual, liveCanonical(at, head));
        assert.ok(actual.includes('LTC|mainnet|2800100|11|7'), 'round id carries the batch seq');
    });

    it('ignores the head snapshot block, which is the bundle maximum, not the signed one', function(){
        let other = Object.assign({}, head, { snapshot_block: 999999 });
        assert.strictEqual(AnchorRecovery.foldWrapperCanonicalForTest(other, section),
            AnchorRecovery.foldWrapperCanonicalForTest(head, section));
    });
});

describe('recovery v3 fold wrapper section lookup', function(){
    function recovery(rows, seen){
        let db = { doQuery: async (sql, params) => { seen.push({ sql, params }); return rows; } };
        return new AnchorRecovery(db, { log: () => {} });
    }

    it('picks the sibling chain section whose signatures equal the head', async function(){
        let seen = [];
        let decoy = Object.assign({}, section, { section_index: 0, validator_signatures: '[]' });
        let found = await recovery([decoy, section], seen).foldWrapperSection(head);
        assert.strictEqual(found, section);
        assert.deepStrictEqual(seen[0].params, [9]);
        assert.ok(/ORDER BY section_index ASC/.test(seen[0].sql));
    });

    it('rejects a head with no matching wrapper section', async function(){
        let decoy = Object.assign({}, section, { validator_signatures: '[]' });
        await assert.rejects(recovery([decoy], []).foldWrapperSection(head), /no wrapper section/);
        await assert.rejects(recovery([], []).foldWrapperSection(head), /no wrapper section/);
    });
});

describe('recovery driver query', function(){
    it('excludes version 3 chain sections, which hold no archive', async function(){
        let seen = [];
        let db = { doQuery: async sql => { seen.push(sql); return []; } };
        await new AnchorRecovery(db, { log: () => {} }).run();
        let driver = seen.find(sql => /FROM anchor_actions a/.test(sql));
        assert.ok(/a\.match_batch_seq IS NOT NULL/.test(driver));
    });
});
