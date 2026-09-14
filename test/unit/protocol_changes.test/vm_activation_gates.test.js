// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The consensus anti-fork gates of the contract VM era: DEPLOY_BASE64_CODE,
// VM_BALANCE_TOKENINFO and VM_ATTESTATION_GETRESPONSE, each pinned to its real
// registration and flag-day boundary. Part of the ProtocolChanges suite whose entry
// is test/unit/protocol_changes.test.js.

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

    // ─── DEPLOY_BASE64_CODE: the consensus anti-fork gate ───────────────────
    // The inline-DEPLOY base64 cutover. A regression in its registration (a zeroed
    // or wrong mainnet flag-day, regtest/testnet flipped off genesis, or the version
    // bumped past the shipping node) silently changes how historical CODE_ENCODING
    // decodes → code_hash → contract_hash → the federation checkpoint, forking the
    // ledger. deploy.test.js stubs isEnabled(), so ONLY this block guards the REAL
    // registration. Keep these assertions in lockstep with protocol_changes.js.
    describe('DEPLOY_BASE64_CODE activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        // The constructor reads config.NETWORK fresh and takes the consensus version as an
        // explicit argument, so a new instance per network/version is all that is
        // needed (no module-cache reset, and no environment mutation).
        function pcFor(network, version = '2.0.0') {
            // Shipping consensus version passed explicitly (compiled pin).
            indexer.config.NETWORK = network; // constructor reads network from the validated config
            return new ProtocolChanges(indexer, version);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['DEPLOY_BASE64_CODE'];
            assert.ok(change, 'DEPLOY_BASE64_CODE must be defined');
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
                'mainnet flag-day must match protocol_changes.js; a wrong value is a second fork');
        });

        it('regtest: enabled from genesis (every block decodes base64)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 0), true);
        });

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 0), true);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('DEPLOY_BASE64_CODE activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        it('mainnet: DISABLED one second below the flag-day (historical DEPLOYs stay hex)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('DEPLOY_BASE64_CODE', 100), true);
        });

        it('a pre-consensus (v1.x) node treats it as not-yet-active; no premature base64', async function () {
            const pc1 = pcFor('regtest', '0.1.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('DEPLOY_BASE64_CODE', 0), false,
                'below the 0.2.0 consensus version the gate is inactive; decode stays hex');
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // ─── VM_BALANCE_TOKENINFO: the consensus anti-fork gate ─────────────────
    // The VM getBalance()/getTokenInfo() reader. Below activation the gateway sees
    // balances:null / tokenInfo:null (original ≤2.7.10 behaviour); at/above it the
    // indexer feeds the buildVmBalancesAndTokenInfo snapshot. A regression in its
    // registration (a zeroed/wrong mainnet flag-day, regtest/testnet flipped off
    // genesis, or the version bumped past the shipping node) silently changes the
    // VM input on the first balance-reading contract → gas_used / emitted_count /
    // ledger movement → contract_hash → the federation checkpoint, forking the
    // ledger even within the 2.x line (2.2.0–2.7.10 lack the reader; 2.7.11+ have
    // it). execute.js/deploy.js call the REAL isEnabled() at all three VM call sites
    // (EXECUTE primary, EXECUTE controller-guard, DEPLOY constructor), so this block
    // guards the registration the call sites depend on. Keep in lockstep with
    // protocol_changes.js.
    describe('VM_BALANCE_TOKENINFO activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        function pcFor(network, version = '2.0.0') {
            // Shipping consensus version passed explicitly (compiled pin).
            indexer.config.NETWORK = network; // constructor reads network from the validated config
            return new ProtocolChanges(indexer, version);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['VM_BALANCE_TOKENINFO'];
            assert.ok(change, 'VM_BALANCE_TOKENINFO must be defined');
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

        it('regtest: enabled from genesis (gateway gets real balances/token-info)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1); // earliest plausible regtest block_time
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 0), true);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('VM_BALANCE_TOKENINFO activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        it('testnet: enabled from genesis', async function () {
            const pc2 = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 0), true);
        });

        it('mainnet: DISABLED one second below the flag-day (gateway still sees null)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), true);
        });

        it('mainnet: ENABLED above the flag-day', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY + 86400);
            assert.strictEqual(await pc2.isEnabled('VM_BALANCE_TOKENINFO', 100), true);
        });

        it('a pre-reader (v1.x) node treats it as not-yet-active; gateway stays null', async function () {
            const pc1 = pcFor('regtest', '0.1.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('VM_BALANCE_TOKENINFO', 0), false,
                'below the 0.2.0 consensus version the gate is inactive; gateway sees null');
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    // ─── VM_ATTESTATION_GETRESPONSE: the consensus anti-fork gate ───
    // The VM xchain.attestation.getResponse() reader. Below activation execute.js
    // passes attestationData:null and getResponse() returns null for every request;
    // at/above it the indexer feeds the getAttestationDataForVM snapshot and a
    // contract reading a prior fulfilled response sees a populated object. A
    // regression in its registration (a zeroed/wrong mainnet flag-day, regtest/
    // testnet flipped off genesis, or the version bumped past the shipping node)
    // silently changes the VM input on the first getResponse-reading contract →
    // divergent state → contract_hash → federation checkpoint, forking the fleet.
    // execute.js calls the REAL isEnabled() at the EXECUTE primary call site, so this
    // block guards the registration that call site depends on. Keep in lockstep with
    // protocol_changes.js.
    describe('VM_ATTESTATION_GETRESPONSE activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        function pcFor(network, version = '2.0.0') {
            // Shipping consensus version passed explicitly (compiled pin).
            indexer.config.NETWORK = network; // constructor reads network from the validated config
            return new ProtocolChanges(indexer, version);
        }

        it('is registered as a v2.0.0 change keyed on block_time, not block_index', function () {
            const change = pcFor('regtest').changes['VM_ATTESTATION_GETRESPONSE'];
            assert.ok(change, 'VM_ATTESTATION_GETRESPONSE must be defined');
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

        it('regtest: enabled from genesis (gateway gets real getResponse data)', async function () {
            const pc2 = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc2.isEnabled('VM_ATTESTATION_GETRESPONSE', 0), true);
        });
    });
});

describe('ProtocolChanges @regression @tier3', function () {
    beforeEach(freshRegistry);

    describe('VM_ATTESTATION_GETRESPONSE activation gate (consensus)', function () {
        const MAINNET_FLAG_DAY = 1786060800; // 2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07 (see protocol_changes.js)

        it('mainnet: DISABLED one second below the flag-day (getResponse stays null)', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY - 1);
            assert.strictEqual(await pc2.isEnabled('VM_ATTESTATION_GETRESPONSE', 100), false);
        });

        it('mainnet: ENABLED at exactly the flag-day boundary', async function () {
            const pc2 = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(MAINNET_FLAG_DAY);
            assert.strictEqual(await pc2.isEnabled('VM_ATTESTATION_GETRESPONSE', 100), true);
        });

        it('a pre-reader (v1.x) node treats it as not-yet-active; getResponse stays null', async function () {
            const pc1 = pcFor('regtest', '0.1.9');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc1.isEnabled('VM_ATTESTATION_GETRESPONSE', 0), false);
        });
    });
});
