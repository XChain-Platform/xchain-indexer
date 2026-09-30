'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, ADDR1, makeListContext } = require('./helpers/list_context.js');
const witness = require('../../../../../bin/verify-list-owner-replay-equivalence.js');

describe('LIST part seams @regression @tier3', function () {
    afterEach(function () {
        sinon.restore();
    });

    for(const format of [2, 3]){
        it('keeps format ' + format + ' unknown and stores only its LIST row', async function () {
            const { indexer, handler } = makeListContext();
            const data = createBaseData({ ACTION: 'LIST', FORMAT: format, SOURCE });

            await handler.parse([String(format), '5', ''], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)');
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createList, data);
            sinon.assert.notCalled(indexer.indexerDb.createListEdit);
            sinon.assert.notCalled(indexer.indexerDb.createListItem);
            sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
        });
    }

    it('keeps TYPE 3 unknown and stores only its LIST row', async function () {
        const { indexer, handler } = makeListContext();
        const data = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });

        await handler.parse(['0', '3', '', '5'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: TYPE (unknown)');
        assert.strictEqual(data['TYPE'], '3');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.createList, data);
        sinon.assert.notCalled(indexer.indexerDb.createListEdit);
        sinon.assert.notCalled(indexer.indexerDb.createListItem);
        sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
    });

    it('loads edit authority through listOwner at the root source', async function () {
        const { indexer, handler } = makeListContext();
        indexer.indexerDb.getListStoredType = sinon.stub().resolves(2);
        indexer.indexerDb.getList.resolves([ADDR1]);
        indexer.indexerDb.getListRootIndex.resolves(5);
        indexer.indexerDb.getListSource.withArgs(5).resolves(SOURCE);
        indexer.indexerDb.isActionAllowed.resolves(true);
        const owner = sinon.spy(handler, 'listOwner');
        const data = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });

        await handler.parse(['1', '1', '5', '', ADDR1], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.calledWithExactly(owner, 5, data);
        sinon.assert.calledWithExactly(indexer.indexerDb.getListSource, 5);
    });

    it('keeps the owner replay rollback matched to the real handler', function () {
        const filename = path.join(__dirname, '../../../../../src/actions/list.js');
        const source = fs.readFileSync(filename, 'utf8');
        const legacy = witness.rollBackListOwner(source);

        assert.ok(legacy.includes('if(bridgeRoles.length){'));
        assert.ok(!legacy.includes("error = 'invalid: LIST_ACTION_INDEX (not owner)'"));
    });
});
