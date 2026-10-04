'use strict';

const assert = require('assert');

const { syncFields } = require('../../../../src/api/health/sync_fields');

function makeIndexer(overrides = {}){
    return Object.assign({
        decoderDb:        { circuitState: 'closed' },
        indexerDb:        { circuitState: 'closed' },
        lastDecoderBlock: 200,
        isSynced:         () => false
    }, overrides);
}

function fields(indexer = makeIndexer(), overrides = {}){
    return syncFields(indexer, Object.assign({
        indexerRunning:   true,
        lastIndexedBlock: 190,
        inFlightBlock:    191
    }, overrides));
}

describe('sync health fields', function(){
    it('is healthy only while running with neither database circuit open', function(){
        const cases = [
            { running: true,  decoder: 'closed', indexer: 'closed', expected: 'healthy' },
            { running: true,  decoder: 'open',   indexer: 'closed', expected: 'unhealthy' },
            { running: true,  decoder: 'closed', indexer: 'open',   expected: 'unhealthy' },
            { running: false, decoder: 'closed', indexer: 'closed', expected: 'unhealthy' }
        ];

        for(const entry of cases){
            const indexer = makeIndexer({
                decoderDb: { circuitState: entry.decoder },
                indexerDb: { circuitState: entry.indexer }
            });
            assert.strictEqual(fields(indexer, { indexerRunning: entry.running }).status, entry.expected);
        }
    });

    it('reports null database circuits when their handles are absent', function(){
        const result = fields(makeIndexer({ decoderDb: null, indexerDb: undefined }));

        assert.strictEqual(result.decoderDbCircuit, null);
        assert.strictEqual(result.indexerDbCircuit, null);
    });

    it('subtracts the indexed height from the decoder height for lag', function(){
        assert.strictEqual(fields(makeIndexer({ lastDecoderBlock: 250 }), {
            lastIndexedBlock: 225
        }).lag, 25);
    });

    it('reports null lag when either height is null or undefined', function(){
        const cases = [
            { decoder: null,      indexed: 190 },
            { decoder: undefined, indexed: 190 },
            { decoder: 200,       indexed: null },
            { decoder: 200,       indexed: undefined }
        ];

        for(const entry of cases){
            const result = fields(makeIndexer({ lastDecoderBlock: entry.decoder }), {
                lastIndexedBlock: entry.indexed
            });
            assert.strictEqual(result.lag, null);
        }
    });

    it('normalizes an undefined in-flight block to null', function(){
        assert.strictEqual(fields(makeIndexer(), { inFlightBlock: undefined }).inFlightBlock, null);
    });

    it('uses the value returned by isSynced', function(){
        for(const expected of [true, false]){
            const result = fields(makeIndexer({ isSynced: () => expected }));
            assert.strictEqual(result.synced, expected);
        }
    });
});
