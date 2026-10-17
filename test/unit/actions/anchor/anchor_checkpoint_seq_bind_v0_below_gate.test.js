'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const { createBaseData } = require('../../../fixtures/mocks');
const { armAnchor, disarmAnchor, v0Params } = require('./anchor.test/helpers/anchor_fixtures.js');
const protocolChanges = require('../../../../src/protocol_changes.js');

const anchorActivation = protocolChanges.copy('anchor_activation.ANCHOR_ACTIVATION');

describe('ANCHOR v0 checkpoint sequence binding below gate @regression @tier3', function () {
    for(const network of ['mainnet', 'testnet']){
        it('keeps ' + network + ' sequence and snapshot independent on the all-rows watermark', async function () {
            const armed = armAnchor();
            try{
                armed.indexer.config.NETWORK = network;
                const db = armed.indexer.indexerDb;
                const data = createBaseData({
                    ACTION: 'ANCHOR',
                    FORMAT: 0,
                    COIN: 'DOGE',
                    BLOCK_INDEX: anchorActivation[network] + 1,
                });

                await armed.handler.parse(v0Params({
                    network,
                    sections: [{ chain: 'BTC', seq: '901', snapshot: '100' }],
                }), data, null);

                assert.strictEqual(data.STATUS, 'valid');
                assert.strictEqual(db.createAnchorAction.callCount, 1);
                assert.strictEqual(db.getMaxAnchorCheckpointSeq.callCount, 1);
                const watermarkRead = db.getMaxAnchorCheckpointSeq.firstCall;
                assert.strictEqual(watermarkRead.args[0], 'BTC');
                assert.strictEqual(watermarkRead.args[1], network);
                assert.ok(!watermarkRead.args[2]);
            } finally {
                disarmAnchor(armed);
            }
        });
    }
});
