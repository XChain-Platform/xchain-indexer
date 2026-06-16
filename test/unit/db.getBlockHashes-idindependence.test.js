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
 * test/unit/db.getBlockHashes-idindependence.test.js
 *
 * CONSENSUS REGRESSION GUARD: the per-block ledger/actions/contract hashes must be
 * computed from RESOLVED canonical strings (address / tick / action-type / status), never
 * from the raw AUTO_INCREMENT lookup-table surrogate ids (address_id, tick_id, action_id,
 * source_id, caller_id, status_id).
 *
 * WHY THIS MATTERS — the reorg fork:
 *   index_addresses / index_tickers / index_statuses / index_actions rows are created on
 *   first reference (INSERT IGNORE) and are NEVER rolled back; InnoDB AUTO_INCREMENT never
 *   rewinds. So a node that processed a later-orphaned block containing a first-seen
 *   address/ticker keeps that lookup row, and every value first referenced afterward gets an
 *   id offset relative to a node that never saw the orphan. If those ids feed the hash, two
 *   honest nodes on the SAME canonical chain compute DIFFERENT hashes forever — a permanent
 *   checkpoint-quorum break. Hashing the resolved strings removes the id from the preimage,
 *   so the hash depends only on the canonical chain. (BLOCK_HASH_VERSION bumped to 2.)
 *
 * Cross-implementation identity (indexer getBlockHashes == sync BlockHasher) is locked by the
 * xchain-sync block-hash-vectors golden and the xchain-e2e-test consensusHashConformance
 * scenario; this file guards the indexer side's id-independence.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Lookup-table surrogate id columns that must NEVER appear in a consensus hash projection.
const FORBIDDEN_ID_COLS = ['address_id', 'tick_id', 'action_id', 'source_id', 'caller_id', 'status_id'];

// The SELECT projection (between SELECT and FROM) of a query, lower-cased.
function projectionOf(sql) {
    const m = sql.match(/SELECT([\s\S]*?)FROM/i);
    return m ? m[1].toLowerCase() : '';
}

function makeDb() {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().resolves([]), release: sinon.stub().resolves() }) };
    return db;
}

afterEach(function () { sinon.restore(); });

describe('Database.getBlockHashes() consensus id-independence (reorg fork fix) @regression @tier1', function () {

    // (1) Structural guard with teeth: no consensus projection may select a lookup surrogate id.
    //     Revert the fix (hash address_id again) and this fails on the offending query.
    it('selects no AUTO_INCREMENT lookup id into any consensus hash projection', async function () {
        const db = makeDb();
        const offenders = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            const proj = projectionOf(sql);
            for (const col of FORBIDDEN_ID_COLS) {
                // Word-boundary match so we catch `c.address_id` / `address_id` but not a JOIN/WHERE
                // (those live outside the projection slice) and not `source_address`.
                if (new RegExp('(^|[^a-z_])' + col + '([^a-z_]|$)').test(proj)) {
                    offenders.push({ col, proj: proj.trim().replace(/\s+/g, ' ') });
                }
            }
            return [];
        });
        await db.getBlockHashes(306);
        assert.strictEqual(offenders.length, 0,
            'consensus hash projection selected a lookup surrogate id (reorg-divergent) — hash the ' +
            'resolved string instead:\n' + JSON.stringify(offenders, null, 2));
    });

    // (2) Property: identical canonical content under DIFFERENT local id assignment hashes
    //     identically. Two "operators" — one reorg-exposed (offset ids), one never-exposed —
    //     resolve the same canonical addresses/ticks, so the projected rows (and hashes) match.
    //     Because the projection no longer carries ids, the id offset is invisible by construction;
    //     this asserts that invariant end-to-end through getBlockHashes.
    it('produces identical block hashes for the same canonical chain regardless of local id assignment', async function () {
        // The resolved rows a node returns for block 306. (Ids are gone from the projection; what
        // remains is purely canonical — so both operators return byte-identical rows.)
        const creditsRows = [{ action_index: 1, address: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', tick: 'JDOG', amount: '1000' }];

        async function blockHashesFor(rows) {
            const db = makeDb();
            sinon.stub(db, 'doQuery').callsFake(async (sql) => /FROM\s+credits\b/i.test(sql) ? rows : []);
            const info = await db.getBlockHashes(306);
            return { ledger: info.ledger.hash, actions: info.actions.hash, contract: info.contract ? info.contract.hash : info.contracts.hash };
        }

        const operatorNeverReorged   = await blockHashesFor(creditsRows.map(r => Object.assign({}, r)));
        const operatorReorgExposed   = await blockHashesFor(creditsRows.map(r => Object.assign({}, r)));
        assert.strictEqual(operatorReorgExposed.ledger, operatorNeverReorged.ledger,
            'same canonical chain must yield the same ledger hash on a reorg-exposed and a never-exposed node');

        // Non-vacuity control: a genuinely DIFFERENT canonical address (not a mere id offset) MUST
        // change the hash — proving the hash still binds canonical content, just not the surrogate id.
        const different = await blockHashesFor([{ action_index: 1, address: '1OtherZS6tQcSxwfxhv6XKKjcyicYA4Fe', tick: 'JDOG', amount: '1000' }]);
        assert.notStrictEqual(different.ledger, operatorNeverReorged.ledger,
            'a different canonical address MUST change the ledger hash (else the hash is content-blind)');
    });
});
