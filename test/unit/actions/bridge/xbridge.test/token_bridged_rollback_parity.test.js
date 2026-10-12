'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../../fixtures/config');
const Utility           = require('../../../../../src/utility');
const Database          = require('../../../../../src/db');
const rederive          = require('../../../../../src/db/rollback/rederive.js');

const TICK_ID = 7;

// A db whose doQuery answers the two statements getTokenInfo issues for one native
// token: the valid ISSUE rows, and the applied-lock probe over an in-memory xbridges
// table that the rollback purge deletes from by action_index.
function makeChain(xbridges) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'createTicker').resolves(TICK_ID);
    sinon.stub(db, 'getTokenSupply').resolves('0');
    db.doQuery = async (sql, args) => {
        if (/FROM\s+issues\s+i/i.test(sql))
            return [{ action_index: 1, tick: 'FUFU', owner: 'addr', decimals: 8, max_supply: '10', max_mint: '1', block_index: 1 }];
        if (/FROM xbridges x/i.test(sql))
            return xbridges.filter(r => r.tick_id === args[0] && r.version === 3 && r.status === 'valid')
                .filter(r => withinBounds(sql, args, r)).map(() => ({ 1: 1 }));
        if (/^DELETE FROM xbridges WHERE action_index >= \?/i.test(sql)) {
            for (let i = xbridges.length - 1; i >= 0; i--)
                if (xbridges[i].action_index >= args[0]) xbridges.splice(i, 1);
            return [];
        }
        return [];
    };
    return db;
}

// Apply the optional as-of bounds the lock probe carries, in placeholder order after tick_id.
function withinBounds(sql, args, row) {
    let next = 1;
    if (/x\.block_index <= \?/.test(sql) && !(row.block_index <= args[next++])) return false;
    if (/x\.action_index < \?/.test(sql) && !(row.action_index < args[next++])) return false;
    return true;
}

const lock = (action_index, status = 'valid', version = 3, block_index = 1) =>
    ({ action_index, tick_id: TICK_ID, version, status, block_index });

describe('tokens.bridged derives from applied xbridges rows @regression', function () {
    afterEach(() => sinon.restore());

    it('rolled-back lock reads 0: is cleared when a rollback orphans the first applied lock, like a fresh replay', async function () {
        const live = [lock(10), lock(20)];
        const db   = makeChain(live);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, 1);

        await rederive.purgeActionScopedTables(db, ['xbridges'], 10);

        const fresh = makeChain([]);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, (await fresh.getTokenInfo('FUFU')).BRIDGED);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, 0);
    });

    it('stays set when only a later lock is orphaned', async function () {
        const live = [lock(10), lock(20)];
        const db   = makeChain(live);
        await rederive.purgeActionScopedTables(db, ['xbridges'], 15);
        const fresh = makeChain([lock(10)]);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, 1);
        assert.strictEqual((await fresh.getTokenInfo('FUFU')).BRIDGED, 1);
    });

    it('ignores refused locks and v4 burns', async function () {
        const db = makeChain([lock(10, 'invalid: TICK (not native here)'), lock(11, 'valid', 4)]);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, 0);
    });

    it('reads BRIDGED as of the requested block and action, not the current tip', async function () {
        const db = makeChain([lock(20, 'valid', 3, 5)]);
        assert.strictEqual((await db.getTokenInfo('FUFU', 4)).BRIDGED, 0);
        assert.strictEqual((await db.getTokenInfo('FUFU', 5)).BRIDGED, 1);
        assert.strictEqual((await db.getTokenInfo('FUFU', 5, 20)).BRIDGED, 0);
        assert.strictEqual((await db.getTokenInfo('FUFU', 5, 21)).BRIDGED, 1);
        assert.strictEqual((await db.getTokenInfo('FUFU')).BRIDGED, 1);
    });
});
