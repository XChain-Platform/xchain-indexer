'use strict';

const assert = require('assert');
const sinon = require('sinon');

const mirrorReads = require('../../../../src/db/database/mirror_reads.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { UNARMED } = require('../../../../src/protocol_changes/core.js');
const {
    archiveHeadPickPredicate,
} = require('../../../../src/db/anchors/archive_head_pick.js');

const FOLD_KEY = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

function stubFoldFloor(height) {
    const read = gateRegistry.registry.read.bind(gateRegistry.registry);
    sinon.stub(gateRegistry.registry, 'read').callsFake((key) => {
        if(key !== FOLD_KEY) return read(key);
        return Object.freeze({ mainnet: UNARMED, testnet: UNARMED, regtest: height });
    });
}

function predicateAt(floor) {
    return archiveHeadPickPredicate('a').replace('?', String(floor));
}

async function captureQuery(network) {
    let captured;
    const doQuery = async function (sql, args) {
        captured = { sql, args };
        return [];
    };
    const db = network ? { config: { NETWORK: network }, doQuery } : { doQuery };
    await mirrorReads.getMaxArchiveBatchSeqByAuthor.call(db, 'DPublisher');
    return captured;
}

describe('getMaxArchiveBatchSeqByAuthor archive-head predicate', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps folded heads out while the fold gate is unarmed', async function () {
        stubFoldFloor(null);
        const captured = await captureQuery();

        assert.ok(captured.sql.includes(predicateAt(UNARMED)));
        assert.doesNotMatch(captured.sql, /a\.version\s*<>\s*2/);
        assert.deepStrictEqual(captured.args, ['DPublisher']);
    });

    it('admits folded heads at the configured activation floor', async function () {
        stubFoldFloor(73);
        const captured = await captureQuery('regtest');

        assert.ok(captured.sql.includes(predicateAt(73)));
        assert.deepStrictEqual(captured.args, ['DPublisher']);
    });
});
