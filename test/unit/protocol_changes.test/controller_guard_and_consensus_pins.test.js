// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The CONTROLLER_GUARD anti-fork gate, the contract-era flag-day cohort, the
// compiled consensus version pin, and the ungated LOCK_NULL_PRIOR_UNSET rule.
// Part of the ProtocolChanges suite whose entry is test/unit/protocol_changes.test.js.

const assert = require('assert');
const { createMockIndexer } = require('../../fixtures/mocks');

// The registry under test and the mock indexer it reads, rebuilt before every
// test so a test that swaps pc or mutates indexer.config never leaks into the next.
let ProtocolChanges, pc, indexer;

function freshRegistry() {
    indexer = createMockIndexer();
    // Set version for the indexer package
    process.env.INDEXER_NETWORK = 'regtest';
    ProtocolChanges = require('../../../src/protocol_changes.js');
    // Consensus version is passed explicitly now that it is a compiled pin.
    pc = new ProtocolChanges(indexer, '0.1.0');
}

// The suite-level pcFor, read by every block below that does not declare its own.
function pcFor(network, version = '2.0.0') {
    // Shipping consensus version passed explicitly (compiled pin).
    indexer.config.NETWORK = network; // constructor reads network from the validated config
    return new ProtocolChanges(indexer, version);
}

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // ─── CONTROLLER_GUARD: the consensus anti-fork gate ─────────────────────
    // The programmable-policy controller guard. Below activation the bound controller's
    // `guard` method is NEVER run; every SEND/ORDER/SWAP/DISPENSER/DESTROY on a controlled
    // token settles with plain semantics, no allow/deny veto, no royalty payout_legs, no guard
    // contract_executions row, exactly like a node that lacks the controller layer. At/above
    // it the shared chokepoint (invokeController) runs the guard, may DENY, and may attach
    // payout_legs the match-time split applies. A regression in its registration (a zeroed/
    // wrong mainnet flag-day, regtest/testnet flipped off genesis, or the version bumped past
    // the shipping node) makes a controller-layer node and a non-controller node settle the
    // SAME guarded action differently → ledger + per-block contract_hash → federation
    // checkpoint, forking on the first guarded action. utility.js invokeController calls the
    // REAL isEnabled() at the single shared chokepoint, so this block guards the registration
    // that gate depends on. Keep in lockstep with protocol_changes.js.
    describe('CONTROLLER_GUARD activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['CONTROLLER_GUARD'];
            assert.ok(change, 'CONTROLLER_GUARD must be defined');
            assert.strictEqual(change.version_major, 0);
            assert.strictEqual(change.version_minor, 2);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed (BTC/LTC/DOGE heights diverge by millions of blocks); all block gates stay 0.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            // testnet/regtest activate at genesis; mainnet on the coordinated flag-day.
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_time, MAINNET_FLAG_DAY,
                'mainnet flag-day must match protocol_changes.js; a wrong value is a fork');
        });

        it('regtest: enabled from genesis (guard runs)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 0), true);
        });

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 0), true);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('CONTROLLER_GUARD activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        it('mainnet: DISABLED one second below the flag-day (guard is a strict no-op)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('CONTROLLER_GUARD', 100), true);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('CONTROLLER_GUARD activation gate (consensus)', function () {
        it('a pre-guard (v1.x) node treats it as not-yet-active; guard stays off', async function () {
            const pc1 = pcFor('regtest', '0.1.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('CONTROLLER_GUARD', 0), false,
                'below the 0.2.0 consensus version the gate is inactive; guard never runs');
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('contract-era flag-day cohort single-source-of-truth (consensus)', function () {
        // These five gates share one coordinated mainnet flag-day and MUST move
        // together: a wrong value on any one is a ledger fork. Four hard-code the
        // literal in protocol_changes.js while only VM_BANNED_ASYNC references the
        // exported constant, so a future edit that updates the constant (or a subset
        // of the literals) but misses the rest would pass CI and activate coupled
        // contract-deploy consensus rules at different boundaries. This pins them
        // equal so any such partial edit fails CI.
        const COHORT = [
            'DEPLOY_BASE64_CODE',
            'ISSUANCE_FEE_EMISSION_EXEMPT',
            'VM_BALANCE_TOKENINFO',
            'CONTROLLER_GUARD',
            'VM_BANNED_ASYNC',
        ];

        it('all five coupled gates share one mainnet_time equal to VM_BANNED_ASYNC_MAINNET_TIME', function () {
            const anchor = ProtocolChanges.VM_BANNED_ASYNC_MAINNET_TIME;
            assert.strictEqual(typeof anchor, 'number',
                'VM_BANNED_ASYNC_MAINNET_TIME must be exported as the cohort anchor');
            for (const name of COHORT) {
                const change = pc.changes[name];
                assert.ok(change, `${name} should be registered`);
                assert.strictEqual(change.mainnet_time, anchor,
                    `${name} mainnet_time must equal VM_BANNED_ASYNC_MAINNET_TIME; a partial flag-day edit forks the ledger`);
            }
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // ─── The consensus version is a compiled pin, not npm metadata ───
    // isEnabled() compares the resolved version against every registered change, so
    // whatever supplies it decides which consensus rules this node applies. Sourcing
    // it from npm_package_version (with a package.json fallback) meant a version bump,
    // a bare `node src/api.js`, or a host with a divergent installed package.json
    // moved consensus silently. These pin the compiled constant and its no-op proof.
    describe('consensus version pin (#3087)', function () {
        it('is a compiled constant equal to the package version', function () {
            const packaged = require('../../../package.json').version;
            assert.strictEqual(typeof ProtocolChanges.CONSENSUS_VERSION, 'string',
                'CONSENSUS_VERSION must be exported');
            assert.strictEqual(ProtocolChanges.CONSENSUS_VERSION, packaged,
                'CONSENSUS_VERSION must equal package.json version; the two moving apart ' +
                'unnoticed is exactly what the pin exists to prevent');
        });

        it('resolves from the compiled pin, ignoring npm_package_version entirely', function () {
            const saved = process.env.npm_package_version;
            try {
                // The pre-pin code read this env var straight into consensus.
                process.env.npm_package_version = '9.9.9';
                const pinned = new ProtocolChanges(indexer);
                assert.strictEqual(pinned.version, ProtocolChanges.CONSENSUS_VERSION,
                    'a hostile/stale npm_package_version must not reach consensus');
                // And with the var absent, which used to hit the package.json fallback.
                delete process.env.npm_package_version;
                assert.strictEqual(new ProtocolChanges(indexer).version, ProtocolChanges.CONSENSUS_VERSION);
            } finally {
                if (saved === undefined) delete process.env.npm_package_version;
                else process.env.npm_package_version = saved;
            }
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('consensus version pin (#3087)', function () {

        it('rejects a malformed explicit override instead of falling back to the pin', function () {
            // A silent fallback would let a broken test seam masquerade as production.
            assert.throws(() => new ProtocolChanges(indexer, '2.0'), /semantic version/);
            assert.throws(() => new ProtocolChanges(indexer, 200), /semantic version/);
            assert.throws(() => new ProtocolChanges(indexer, null), /semantic version/);
        });

        it('no-op proof passes on a matching host and throws on a drifted npm_package_version', function () {
            const saved = process.env.npm_package_version;
            try {
                delete process.env.npm_package_version;
                assert.strictEqual(ProtocolChanges.assertConsensusVersionPin(),
                    ProtocolChanges.CONSENSUS_VERSION);
                process.env.npm_package_version = ProtocolChanges.CONSENSUS_VERSION;
                assert.doesNotThrow(() => ProtocolChanges.assertConsensusVersionPin());
                // A host that would have resolved a DIFFERENT version pre-pin is a host
                // where shipping the pin moves consensus: abort rather than report.
                process.env.npm_package_version = '1.2.3';
                assert.throws(() => ProtocolChanges.assertConsensusVersionPin(), /NOT a no-op/);
            } finally {
                if (saved === undefined) delete process.env.npm_package_version;
                else process.env.npm_package_version = saved;
            }
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // ─── redesign: LOCK_NULL_PRIOR_UNSET ships ungated ───────────────
    // No v1 three-key train registration applies, and no Key A block TIME
    // (1796083200 / 2026-12-01) arms it. A mandatory rebase stands in for the activation
    // surface as a fleet-wide wipe-and-replay, so this rule ships
    // plain. A reintroduced flag day here is a divergence window: nodes replaying
    // before and after the date would disagree.
    describe('LOCK_NULL_PRIOR_UNSET is ungated (redesign)', function () {
        it('carries no activation time or block on any network', function () {
            const change = pc.changes['LOCK_NULL_PRIOR_UNSET'];
            assert.ok(change, 'LOCK_NULL_PRIOR_UNSET must be registered');
            for (const field of ['mainnet_time', 'testnet_time', 'regtest_time',
                                 'mainnet_block', 'testnet_block', 'regtest_block']) {
                assert.strictEqual(change[field], 0,
                    `${field} must be 0; the redesign batch ships ungated (spec §0)`);
            }
        });

        it('retired the v1 train constant rather than leaving it dangling', function () {
            assert.strictEqual(ProtocolChanges.XC637_TRAIN_TIME, undefined,
                'the v1 Key A anchor must not survive the redesign');
        });
    });
});
