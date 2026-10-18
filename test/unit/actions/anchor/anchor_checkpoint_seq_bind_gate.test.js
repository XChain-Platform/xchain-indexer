'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../fixtures/mocks.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { checkpointSeqBindReason } = require('../../../../src/actions/anchor/validate.js');
const { armingEnv } = require('../../../../bin/consensus-identity.js');
const { UNARMED, UNPINNED } = require('../../../../src/protocol_changes/core.js');
const { armAnchor, disarmAnchor, v0Params, v1Params } =
    require('./anchor.test/helpers/anchor_fixtures.js');
const { v3Params } = require('./anchor.test/helpers/anchor_v3_fixtures.js');

const GATE = 'anchor_checkpoint_seq_bind_activation.ANCHOR_CHECKPOINT_SEQ_BIND_ACTIVATION';
const ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';

function restoreEnv(saved){
    if(saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
}

describe('ANCHOR checkpoint sequence binding gate @regression @tier1', function () {
    it('ships unarmed on mainnet, armed on testnet at its v0.25.0 heights, and inert on regtest', function () {
        const saved = process.env[ENV];
        try {
            delete process.env[ENV];
            const row = gateRegistry.get(GATE);
            assert.strictEqual(row.mainnet, UNARMED);
            assert.strictEqual(row.testnet, UNARMED);
            // The v0.25.0 cut arms DOGE:testnet at 68008400.
            assert.strictEqual(row['DOGE:testnet'], 68008400);
            assert.strictEqual(row.regtest, UNPINNED);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'DOGE', 1e9, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'DOGE', 68008399, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'DOGE', 68008400, null), true);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'DOGE', 1e9, null), false);
        } finally {
            restoreEnv(saved);
        }
    });

    it('arms regtest at the height named by the environment', function () {
        const saved = process.env[ENV];
        try {
            process.env[ENV] = '7';
            assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'DOGE', 6, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'DOGE', 7, null), true);
            assert.strictEqual(armingEnv({ [ENV]: '7' })[ENV], '7');
        } finally {
            restoreEnv(saved);
        }
    });

    it('exposes the canonical-safe binding reason beside the activation', function () {
        assert.strictEqual(checkpointSeqBindReason({ CHECKPOINT_SEQ: '900', SNAPSHOT_BLOCK: '900' }), null);
        assert.match(checkpointSeqBindReason({ CHECKPOINT_SEQ: '901', SNAPSHOT_BLOCK: '900' }), /^CHECKPOINT_SEQ \(/);
        assert.match(checkpointSeqBindReason({ CHECKPOINT_SEQ: '0900', SNAPSHOT_BLOCK: '0900' }), /^CHECKPOINT_SEQ \(/);
        assert.match(checkpointSeqBindReason({
            CHECKPOINT_SEQ: '9007199254740993',
            SNAPSHOT_BLOCK: '9007199254740993',
        }), /^CHECKPOINT_SEQ \(/);
    });

    for(const format of [0, 1]){
        it('binds v' + format + ' validation after activation', async function () {
            const saved = process.env[ENV];
            const armed = armAnchor();
            try {
                process.env[ENV] = '0';
                const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: format,
                    COIN: 'DOGE', BLOCK_INDEX: 100 });
                const params = format === 0 ? v0Params({
                    sections: [{ chain: 'BTC', seq: '901', snapshot: '900' }],
                    snapshot: '900',
                }) : v1Params(JSON.stringify({ matches: [{ id: 1 }] }), {
                    seq: '901', snapshot: '900',
                });

                await armed.handler.parse(params, data, null);

                assert.match(data.STATUS, /^invalid: (SECTION 0 )?CHECKPOINT_SEQ \(/);
            } finally {
                disarmAnchor(armed);
                restoreEnv(saved);
            }
        });
    }

    it('binds every v3 section after activation', async function () {
        const foldEnv = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
        const saved = process.env[ENV];
        const savedFold = process.env[foldEnv];
        const armed = armAnchor();
        try {
            process.env[ENV] = '0';
            process.env[foldEnv] = '0';
            const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3,
                COIN: 'DOGE', BLOCK_INDEX: 100 });

            await armed.handler.parse(v3Params(), data, null);

            assert.match(data.STATUS, /^invalid: SECTION 0 CHECKPOINT_SEQ \(/);
        } finally {
            disarmAnchor(armed);
            restoreEnv(saved);
            if(savedFold === undefined) delete process.env[foldEnv];
            else process.env[foldEnv] = savedFold;
        }
    });
});
