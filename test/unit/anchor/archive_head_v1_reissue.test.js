/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 *
 * A v1 archive head that re-uses its author's MATCH_BATCH_SEQ on different content
 * takes the re-issue retry reason from the v1 re-issue gate, read at the head's own
 * block; below the gate it indexes valid without reading the author's stored heads.
 * An exact re-broadcast (same CRC and match count) stays valid on both sides.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../fixtures/mocks.js');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const { ARCHIVE_REISSUE_RETRY_REASON } = require(
    '../../../src/actions/anchor/archive/archive_reissue.js');
const {
    armAnchor, disarmAnchor, v1Params, crc32Hex, ARCHIVE_JSON
} = require('../actions/anchor/anchor.test/helpers/anchor_fixtures.js');

const V1_REISSUE_REFUSAL_ACTIVATION =
    'archive_v1_reissue_refusal_activation.ARCHIVE_V1_REISSUE_REFUSAL_ACTIVATION';

// A stored head from the same author under seq 0: a different archive, or the
// incoming one again when `same` is set.
function storedHeads(data, same){
    return sinon.stub().callsFake(async (author, batchSeq) => {
        assert.strictEqual(author, data.SOURCE);
        assert.strictEqual(batchSeq, 0);
        return same
            ? [{ batch_crc32: crc32Hex(ARCHIVE_JSON), match_count: Number(data.MATCH_COUNT) }]
            : [{ batch_crc32: 'cafef00d', match_count: 99 }];
    });
}

async function parseHead(armed, gateActive, same){
    const db = armed.indexer.indexerDb;
    const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
    db.getArchiveHeadsByAuthorAndSeq = storedHeads(data, same);
    const gate = stubActiveAt(sinon, V1_REISSUE_REFUSAL_ACTIVATION, gateActive);
    await armed.handler.parse(v1Params(ARCHIVE_JSON), data, null);
    return { db, data, gate };
}

describe('ANCHOR v1 archive head same-author re-issue refusal @regression @tier3', function(){
    let armed;
    beforeEach(function(){ armed = armAnchor(); });
    afterEach(function(){ disarmAnchor(armed); });

    it('refuses a v1 head re-using its seq on different content at the gate', async function(){
        const { db, data, gate } = await parseHead(armed, true, false);

        assert.strictEqual(data.STATUS, ARCHIVE_REISSUE_RETRY_REASON);
        assert.match(data.STATUS, /^invalid: MATCH_BATCH_SEQ \(retry; /);
        sinon.assert.calledOnce(db.getArchiveHeadsByAuthorAndSeq);
        sinon.assert.calledWith(gate, V1_REISSUE_REFUSAL_ACTIVATION, 'regtest', 'DOGE', Number(data.BLOCK_INDEX));
        sinon.assert.calledOnce(db.createAnchorAction);
        assert.strictEqual(db.createAnchorAction.firstCall.args[0].STATUS, ARCHIVE_REISSUE_RETRY_REASON);
    });

    it('keeps an exact re-broadcast valid at the gate', async function(){
        const { db, data } = await parseHead(armed, true, true);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnce(db.getArchiveHeadsByAuthorAndSeq);
        assert.strictEqual(db.createAnchorAction.firstCall.args[0].BATCH_CRC32, crc32Hex(ARCHIVE_JSON));
    });

    it('keeps a fresh seq valid at the gate', async function(){
        const db = armed.indexer.indexerDb;
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        db.getArchiveHeadsByAuthorAndSeq = sinon.stub().resolves([]);
        stubActiveAt(sinon, V1_REISSUE_REFUSAL_ACTIVATION, true);

        await armed.handler.parse(v1Params(ARCHIVE_JSON), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(db.getArchiveHeadsByAuthorAndSeq, data.SOURCE, 0);
    });

    it('indexes the conflicting head valid below the gate without reading the stored heads', async function(){
        const { db, data } = await parseHead(armed, false, false);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(db.getArchiveHeadsByAuthorAndSeq);
        assert.strictEqual(db.createAnchorAction.firstCall.args[0].STATUS, 'valid');
    });

    it('keeps an exact re-broadcast valid below the gate', async function(){
        const { db, data } = await parseHead(armed, false, true);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(db.getArchiveHeadsByAuthorAndSeq);
    });
});
