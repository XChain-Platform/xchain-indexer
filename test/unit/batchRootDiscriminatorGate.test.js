/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/batchRootDiscriminatorGate.test.js
 *
 * The flag-day gate on the per-subcommand root discriminator.
 *
 * The ATTEST request_id / XCALL call_id preimages carry a per-root discriminator
 * whose value is the root action's on-chain output index TX_VOUT, on the assumption
 * that TX_VOUT names a root uniquely within a transaction. A BATCH breaks it:
 * actions.js assigns TX_VOUT once per TRANSACTION and every subcommand is its own
 * root under it, each seeding call-path ''. Two EXECUTE subcommands against the same
 * contract therefore derived the IDENTICAL request_id and the second request was
 * dropped by db.createAttestationRequest's prior-row guard.
 *
 * This suite pins both halves of the remedy:
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on testnet and
 *     regtest, mainnet parked on the UNARMED sentinel (the operator still owes the
 *     activation instant, so no guessed value may ship);
 *   - the FORM the discriminator takes on each side of the gate: below it the bare
 *     TX_VOUT, byte for byte what the live chains have always hashed; above it the
 *     composite "<TX_VOUT>.<position>", which must stay distinct for positions that
 *     Number() would fold together ('3.1' vs '3.10').
 *
 * The two-EXECUTE BATCH regression itself (real Batch handler -> real VM gateway ->
 * real ATTEST v0 handler) lives in test/unit/actions/batch-execute-attest.test.js.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');
const { BATCH_ROOT_DISCRIMINATOR_GATE, rootDiscriminator, resolveRootDiscriminator } =
    require('../../src/batch_root_discriminator.js');

const GATE = BATCH_ROOT_DISCRIMINATOR_GATE;

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the same boundary the sibling unarmed-gate suites use
// to tell a scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '0.2.0'), indexer };
}

describe('BATCH per-subcommand root discriminator flag day @regression @tier1', function(){

    describe('registration', function(){

        it('is named on ONE gate constant the call sites share', function(){
            // execute.js (root, guard, emission) and deploy.js all import this name.
            // A second literal anywhere means two sites can gate differently and derive
            // two ids for one emission.
            assert.strictEqual(GATE, 'BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR');
        });

        it('is a time-keyed 2.0.0 change, genesis-active on testnet and regtest', function(){
            const change = pcFor('regtest').pc.changes[GATE];
            assert.ok(change, GATE + ' must be registered');
            assert.strictEqual(change.version_major, 0);
            assert.strictEqual(change.version_minor, 2);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed: EXECUTE runs on BTC, LTC and DOGE, whose heights diverge by
            // millions of blocks, so no single height names one cutover across all three.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
        });

        it('mainnet is UNARMED: the operator owes the activation instant', function(){
            const sentinel = ProtocolChanges.BATCH_ROOT_SUB_INDEX_MAINNET_TIME;
            assert.strictEqual(typeof sentinel, 'number', 'the sentinel must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, sentinel);
            // A value inside any plausible chain lifetime means somebody armed a
            // consensus-preimage change without the operator's flag day.
            assert.ok(sentinel > YEAR_2100,
                'the mainnet arm must stay a far-future UNARMED sentinel until the instant is ratified');
        });

        it('regtest: active from genesis, so drills and suites run the post-flag-day rule', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('mainnet: inert at any real block time while the sentinel stands', async function(){
            const { pc, indexer } = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(YEAR_2100);
            assert.strictEqual(await pc.isEnabled(GATE, 1000000), false);
        });
    });

    describe('the discriminator form on each side of the gate', function(){

        it('gate OFF: the bare TX_VOUT, unchanged for a BATCH subcommand too', function(){
            // This is the pre-flag-day preimage input byte for byte. It is also the
            // defect: both subcommands hash the same root, which is why replay below
            // the flag day must keep reproducing it.
            assert.strictEqual(rootDiscriminator(4, 0, false), 4);
            assert.strictEqual(rootDiscriminator(4, 1, false), 4);
            assert.strictEqual(rootDiscriminator(4, null, false), 4);
        });

        it('gate ON: a non-BATCH root still hashes the bare TX_VOUT', function(){
            // No BATCH_POSITION means the action is not a subcommand, so nothing about
            // its id moves across the flag day.
            assert.strictEqual(rootDiscriminator(4, null, true), 4);
            assert.strictEqual(rootDiscriminator(4, undefined, true), 4);
        });

        it('gate ON: a BATCH subcommand hashes "<TX_VOUT>.<position>"', function(){
            assert.strictEqual(rootDiscriminator(4, 0, true), '4.0');
            assert.strictEqual(rootDiscriminator(4, 1, true), '4.1');
        });

        it('positions Number() would fold together stay distinct', function(){
            // Number('3.10') === Number('3.1'). The discriminator is a STRING token on
            // both sides of the wire for exactly this reason; folding it re-collides the
            // eleventh subcommand with the second.
            const a = rootDiscriminator(3, 1, true);
            const b = rootDiscriminator(3, 10, true);
            assert.notStrictEqual(a, b);
            assert.strictEqual(Number(a), Number(b),
                'the trap this guards against: as NUMBERS the two are equal');
        });

        it('carries no ":" so it stays one preimage field', function(){
            // ':' is the preimage separator; a discriminator containing one would shift
            // every following field and silently change the derivation.
            assert.strictEqual(String(rootDiscriminator(12, 34, true)).indexOf(':'), -1);
        });

        it('a missing TX_VOUT keeps hashing 0, as it always has', function(){
            assert.strictEqual(rootDiscriminator(null, null, true), 0);
            assert.strictEqual(rootDiscriminator(undefined, null, false), 0);
            assert.strictEqual(rootDiscriminator(null, 2, true), '0.2');
        });
    });

    describe('resolveRootDiscriminator (the form every call site uses)', function(){

        afterEach(() => sinon.restore());

        function pcStub(enabled){
            return { isEnabled: sinon.stub().resolves(enabled) };
        }

        it('does not consult the activation at all when the action is not a subcommand', async function(){
            // The gate cannot change the answer outside a BATCH, and this runs once per
            // emission in the block loop, so the lookup is skipped rather than paid for.
            const pc = pcStub(true);
            assert.strictEqual(await resolveRootDiscriminator(pc, 100, 4, null), 4);
            assert.strictEqual(await resolveRootDiscriminator(pc, 100, 4, undefined), 4);
            assert.strictEqual(pc.isEnabled.callCount, 0);
        });

        it('consults THE gate for a subcommand and appends the position when it is on', async function(){
            const pc = pcStub(true);
            assert.strictEqual(await resolveRootDiscriminator(pc, 100, 4, 2), '4.2');
            assert.ok(pc.isEnabled.calledOnceWith(BATCH_ROOT_DISCRIMINATOR_GATE, 100),
                'the activation must be read on the gate name, at the processing block');
        });

        it('leaves a subcommand on the bare TX_VOUT below the flag day', async function(){
            const pc = pcStub(false);
            assert.strictEqual(await resolveRootDiscriminator(pc, 100, 4, 2), 4);
        });
    });
});
