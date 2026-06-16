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
 * test/unit/rollback-attestation-stats.test.js
 *
 * Behavioral regression for attest_validator_stats recompute on reorg.
 *
 * attest_validator_stats is a monotone aggregate: incrementAttestationValidatorStat
 * bumps fulfilled_count / missed_count / slashed_count on a (validator_pubkey,
 * provider_id) row that carries no block FK, so neither generic rollback delete
 * loop can touch it. A blanket delete would also wipe increments earned in
 * surviving blocks. Rollback._recomputeAttestationValidatorStats() therefore
 * drops only the rows whose most-recent touch is in the orphaned range and
 * rebuilds them from the surviving ledger (verified signatures on STATUS='ok'
 * responses + responsible-set members of expired requests) — matching exactly
 * what a from-genesis replay to block_index-1 would have produced.
 *
 * If that path ever silently reverts to the old append-monotone behaviour, two
 * operators with different reorg histories diverge on these counters and (once
 * Phase 4 slashing consumes them) on ledger_hash. This test drives the real
 * recompute against an in-memory model of the source tables and asserts the
 * rebuilt rows equal a fresh aggregation — the precise invariant a reorg must
 * preserve.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Rollback              = require('../../src/rollback.js');

describe('Rollback attest_validator_stats recompute @regression @tier3', function () {
    this.timeout(0);

    const N        = 100;          // rollback target: orphan everything at/after this block
    const VALID_ID = 7;            // arbitrary status id returned for 'valid'
    const PROV     = 'provider-1';

    const pkA = 'aa'.repeat(33);   // affected: touched in orphaned range, survives partially
    const pkB = 'bb'.repeat(33);   // untouched: last touch pre-N, must be left exactly as-is
    const pkC = 'cc'.repeat(33);   // affected but fully orphaned: must disappear entirely

    let indexer, rollback, statsStore;

    // Helper: serialise the fake stats table into a comparable plain object.
    const dump = () => {
        const out = {};
        for (const [k, r] of statsStore) out[k] = r;
        return out;
    };

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);

        // ── In-memory attest_validator_stats (post block-delete state) ──
        // Each value mirrors a real row. last_updated_block decides "affected".
        statsStore = new Map([
            [`${pkA}|${PROV}`, { validator_pubkey: pkA, provider_id: PROV, fulfilled_count: 5, missed_count: 2, slashed_count: 0, quality_score: 0, last_updated_block: 105 }],
            [`${pkB}|${PROV}`, { validator_pubkey: pkB, provider_id: PROV, fulfilled_count: 3, missed_count: 0, slashed_count: 0, quality_score: 0, last_updated_block: 98 }],
            [`${pkC}|${PROV}`, { validator_pubkey: pkC, provider_id: PROV, fulfilled_count: 1, missed_count: 0, slashed_count: 0, quality_score: 0, last_updated_block: 110 }],
        ]);

        // Surviving STATUS='ok' response rows whose validator_signatures JSON column
        // holds the verified sigs (block_index < N — the block deletes already pruned
        // the rest). pkA appears on two ok responses (earns 2, last block 90); pkC
        // earned none post-rollback (its only signatures were orphaned).
        const okResponses = [
            { provider_id: PROV, validator_signatures: JSON.stringify([{ pubkey: pkA, sig: 'ab'.repeat(64) }]), block_index: 90 },
            { provider_id: PROV, validator_signatures: JSON.stringify([{ pubkey: pkA, sig: 'cd'.repeat(64) }]), block_index: 88 },
        ];

        // Surviving requests that WOULD have expired in a replay to N-1: deadline
        // before N-1 and no valid response. R1's responsible set (redundancy 1
        // over a single-validator capability set = [pkA]) earns pkA one miss.
        const expiredReqs = [
            { request_id: 'r1'.repeat(32), provider_id: PROV, redundancy: 1, block_index: 20, deadline_block: 50 },
        ];

        // getValidatorsByCapability is the deterministic snapshot the live expiry
        // path consulted; for block 20 the attestation set is just [pkA].
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: pkA }]);
        indexer.indexerDb.getStatusId = sinon.stub().resolves(VALID_ID);

        // Route the recompute's raw SQL at the in-memory model.
        indexer.indexerDb.doQuery = sinon.stub().callsFake(async (query, args) => {
            // 1. pairs whose counters may include orphaned increments
            if (/SELECT\s+validator_pubkey,\s*provider_id/i.test(query)) {
                const cutoff = args[0];
                return [...statsStore.values()]
                    .filter(r => r.last_updated_block >= cutoff)
                    .map(r => ({ validator_pubkey: r.validator_pubkey, provider_id: r.provider_id }));
            }
            // 2. drop the stale rows
            if (/DELETE FROM\s+attest_validator_stats/i.test(query)) {
                const cutoff = args[0];
                for (const [k, r] of [...statsStore])
                    if (r.last_updated_block >= cutoff) statsStore.delete(k);
                return [];
            }
            // 3. fulfilled_count source: verified sigs (JSON) on ok response rows
            if (/FROM\s+attests/i.test(query) && /response_status\s*=\s*'ok'/i.test(query)) {
                return okResponses;
            }
            // 4. missed_count source: surviving requests that would have expired
            if (/FROM\s+attests/i.test(query) && /NOT\s+EXISTS/i.test(query)) {
                assert.strictEqual(args[0], N - 1, 'expiry cutoff must be block_index-1');
                assert.strictEqual(args[1], VALID_ID, 'expiry NOT EXISTS must filter on the valid status id');
                return expiredReqs;
            }
            // 5. re-insert recomputed rows (INSERT ... ON DUPLICATE KEY UPDATE)
            if (/INSERT INTO\s+attest_validator_stats/i.test(query)) {
                const [pubkey, provider, fulfilled, missed, lastBlock] = args;
                statsStore.set(`${pubkey}|${provider}`, {
                    validator_pubkey: pubkey, provider_id: provider,
                    fulfilled_count: fulfilled, missed_count: missed,
                    slashed_count: 0, quality_score: 0, last_updated_block: lastBlock,
                });
                return [];
            }
            return [];
        });
    });

    it('rebuilds affected rows to match a fresh aggregation from the source tables', async function () {
        await rollback._recomputeAttestationValidatorStats(N);

        const result = dump();

        // pkA: recomputed from surviving ledger, NOT the stale 5/2 it carried.
        assert.deepStrictEqual(result[`${pkA}|${PROV}`], {
            validator_pubkey: pkA, provider_id: PROV,
            fulfilled_count: 2,   // 2 surviving verified signatures
            missed_count: 1,      // 1 expired request, responsible set = [pkA]
            slashed_count: 0, quality_score: 0,
            last_updated_block: 90, // max(last fulfilled block 90, expiry block 51)
        }, 'pkA must be rebuilt to its fresh aggregate, discarding orphaned increments');

        // pkB: never touched in the orphaned range — left byte-for-byte intact.
        assert.deepStrictEqual(result[`${pkB}|${PROV}`], {
            validator_pubkey: pkB, provider_id: PROV,
            fulfilled_count: 3, missed_count: 0,
            slashed_count: 0, quality_score: 0, last_updated_block: 98,
        }, 'pkB was not in the orphaned range and must not be modified');

        // pkC: entire history orphaned, no surviving source rows — row stays gone,
        // exactly as a from-genesis replay would never have created it.
        assert.ok(!(`${pkC}|${PROV}` in result),
            'pkC had no surviving ledger rows and must not be reinserted');
    });

    it('matches an independent fresh aggregation computed from the same sources', async function () {
        // Snapshot what a clean replay would produce, derived independently here.
        const expected = {
            // pkA: 2 fulfilled (sigs) + 1 missed (responsible for R1)
            [`${pkA}|${PROV}`]: { fulfilled_count: 2, missed_count: 1 },
            // pkB: untouched survivor keeps its existing counts
            [`${pkB}|${PROV}`]: { fulfilled_count: 3, missed_count: 0 },
        };

        await rollback._recomputeAttestationValidatorStats(N);
        const result = dump();

        for (const key of Object.keys(expected)) {
            assert.ok(result[key], `expected row ${key} to exist after recompute`);
            assert.strictEqual(result[key].fulfilled_count, expected[key].fulfilled_count, `fulfilled_count for ${key}`);
            assert.strictEqual(result[key].missed_count,    expected[key].missed_count,    `missed_count for ${key}`);
        }
        // No extra rows beyond the fresh aggregation.
        assert.deepStrictEqual(Object.keys(result).sort(), Object.keys(expected).sort(),
            'recomputed table must contain exactly the rows a fresh aggregation yields');
    });

    it('is a no-op when no row was touched in the orphaned range', async function () {
        // Push every row's last touch below the rollback target.
        for (const r of statsStore.values()) r.last_updated_block = N - 5;
        const before = dump();

        await rollback._recomputeAttestationValidatorStats(N);

        assert.deepStrictEqual(dump(), before,
            'with nothing touched at/after N the stats table must be left unchanged');
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled,
            'no expiry recompute should run when there are no affected pairs');
    });
});
