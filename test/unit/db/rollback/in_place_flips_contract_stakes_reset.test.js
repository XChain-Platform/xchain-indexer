// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * Pins the contract_stakes deactivation reset in clearOrphanedDeactivations.
 *
 * The reset joins the surviving contract_stakes row to its orphaned contract_unstakes
 * row on source_id, not on the signing key. A DELEGATE v1 rotation can move the cooldown
 * row to a new key while the deactivated stake row keeps the old one, so a signing_pubkey_id
 * join misses and strands the stake with a stale deactivation_block. The statement is
 * captured off the shipped function through a stub db, so the assertion is on the SQL the
 * rollback actually issues.
 */

'use strict';

const assert = require('assert');
const flips  = require('../../../../src/db/rollback/in_place_flips');

async function capture(blockIndex, delay) {
    const calls = [];
    const db = { doQuery: async (query, args) => { calls.push({ query, args }); } };
    await flips.clearOrphanedDeactivations(db, blockIndex, delay);
    return calls;
}

const norm = s => s.replace(/\s+/g, ' ').trim();

describe('rollback contract_stakes deactivation reset', () => {

    let stmt, calls;

    before(async () => {
        calls = await capture(100, 7);
        const hits = calls.filter(c => /^UPDATE contract_stakes\b/.test(norm(c.query)));
        assert.strictEqual(hits.length, 1, 'exactly one UPDATE contract_stakes statement');
        stmt = hits[0];
    });

    it('joins contract_unstakes on source_id', () => {
        assert.ok(/JOIN contract_unstakes cu ON cu\.source_id = cs\.source_id\b/.test(norm(stmt.query)),
            'join must key on source_id');
    });

    it('also matches the stake by target contract and tick', () => {
        const q = norm(stmt.query);
        assert.ok(q.includes('cu.target_contract_index = cs.target_contract_index'));
        assert.ok(q.includes('cu.tick_id = cs.tick_id'));
    });

    it('does not join on the signing key', () => {
        assert.ok(!/signing_pubkey_id/.test(stmt.query), 'a key join strands stakes after a rotation');
    });

    it('clears only the exact orphaned stamp', () => {
        const q = norm(stmt.query);
        assert.ok(q.includes('SET cs.deactivation_block = NULL'));
        assert.ok(q.includes('cu.block_index >= ?'));
        assert.ok(q.includes('cs.deactivation_block IS NOT NULL'));
        assert.ok(q.includes('cs.deactivation_block = cu.block_index + ?'));
        assert.deepStrictEqual(stmt.args, [100, 7]);
    });

    it('runs the four resets in order, contract_stakes third', () => {
        const tables = calls.map(c => /^UPDATE (\w+)/.exec(norm(c.query))[1]);
        assert.deepStrictEqual(tables, ['stakes', 'delegations', 'contract_stakes', 'contract_delegations']);
    });
});
