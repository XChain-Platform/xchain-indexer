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
 * test/unit/batchIssuanceLimitsGate.test.js
 *
 * The flag-day gate on the BATCH issuance-limits rework.
 *
 * One protocol change registers the whole set (dotted-TICK exemption, the global
 * 250-command cap, batch-cumulative fee/settlement accounting, the caret-TICK and
 * ticker-intern tightenings) so a heterogeneous fleet can never run half of it.
 *
 * This suite pins the two things nothing else can catch:
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on testnet and
 *     regtest, mainnet parked on the UNARMED sentinel. The set carries a loosening
 *     AND several tightenings at once, so a guessed instant forks a from-genesis
 *     replay in both directions;
 *   - the ORDERING against BATCH_SUBACTION_NORMALIZATION. Classification reads the
 *     TICK out of NORMALIZED sub-command params (params[1]); below the normalization
 *     flag a legacy-format sub-action has not had its implied VERSION 0 injected, so
 *     params[1] is not the TICK and every classification is wrong. isEnabled() has no
 *     notion of one change depending on another, so the ordering lives here or nowhere.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

const GATE          = 'BATCH_ISSUANCE_LIMITS';
const NORMALIZATION = 'BATCH_SUBACTION_NORMALIZATION';

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the same boundary the sibling unarmed-gate suites use
// to tell a scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '2.0.0'), indexer };
}

describe('BATCH issuance-limits flag day @regression @tier1', function(){

    describe('registration', function(){

        it('is a time-keyed 2.0.0 change, genesis-active on testnet and regtest', function(){
            const change = pcFor('regtest').pc.changes[GATE];
            assert.ok(change, GATE + ' must be registered');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed: BATCH runs on BTC, LTC and DOGE, whose heights diverge by
            // millions of blocks, so no single height names one cutover across all three.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
        });

        it('mainnet is UNARMED: the operator owes the activation instant', function(){
            const sentinel = ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME;
            assert.strictEqual(typeof sentinel, 'number', 'the sentinel must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, sentinel);
            // A value inside any plausible chain lifetime means somebody armed a set that
            // both loosens and tightens consensus without the operator's flag day.
            assert.ok(sentinel > YEAR_2100,
                'the mainnet arm must stay a far-future UNARMED sentinel until the instant is ratified');
        });

        it('regtest: active from genesis, so drills and suites run the post-flag-day rules', async function(){
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

    describe('ordering against BATCH_SUBACTION_NORMALIZATION', function(){

        // The dependency is real code, not bookkeeping: the limit scan classifies an ISSUE
        // by params[1], which is only the TICK once normalizeSubAction has injected the
        // implied legacy VERSION 0. A window where this gate is live and normalization is
        // not would classify legacy-format sub-commands off the wrong field.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before normalization', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const norm    = changes[NORMALIZATION];
                assert.ok(gate, GATE + ' must be registered');
                assert.ok(norm, NORMALIZATION + ' must be registered');
                assert.ok(gate[network + '_time'] >= norm[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', BEFORE ' + NORMALIZATION + ' at ' + norm[network + '_time'] +
                    '; the limit scan would classify un-normalized params');
                assert.ok(gate[network + '_block'] >= norm[network + '_block'],
                    GATE + ' must not be height-gated below ' + NORMALIZATION + ' on ' + network);
            });
        }
    });
});
