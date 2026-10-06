/*
 * Document the known attest batch head re-stamp gap.
 * Rewrite this characterization test when the flag-day state-hash class lands.
 */
'use strict';

const assert = require('assert');
const { buildStateHashData } = require('../../../../src/consensus/state_hash');

function recordingDb(sqlReads){
    async function record(sql){
        sqlReads.push(sql);
        return [];
    }
    return {
        doQuery: record,
        doQueryStrict: record,
        getStatusId: async () => null,
    };
}

describe('state_hash attest batch head stamp known gap @regression', () => {
    it('omits the surviving v5 batch head stamp from SQL reads and the preimage', async function(){
        const sqlReads = [];
        const data = await buildStateHashData(recordingDb(sqlReads), 41, {
            activationDelay: null,
            gasTick: 'XCHAIN',
            network: 'regtest',
            coin: 'BTC',
        });

        const attestReads = sqlReads
            .map(sql => sql.replace(/\s+/g, ' ').trim())
            .filter(sql => /\b(?:FROM|JOIN)\s+`?attests`?\b/i.test(sql));

        // Confirm attests are read only through the existing v0 request_status class.
        assert.strictEqual(attestReads.length, 1, 'only the v0 request_status class may read attests');
        assert.match(attestReads[0], /\bWHERE\s+version\s*=\s*0\b/i);
        assert.ok(attestReads.every(sql => !/\bversion\s*=\s*5\b/i.test(sql)));
        assert.ok(attestReads.every(sql => !/\bversion\s+IN\s*\(/i.test(sql)));
        assert.deepStrictEqual(data.request_status.attests, []);

        const preimageKeys = [];
        JSON.stringify(data, (key, value) => {
            if(key) preimageKeys.push(key);
            return value;
        });
        // Confirm no preimage key identifies the omitted attest batch class.
        assert.deepStrictEqual(
            preimageKeys.filter(key => /attest/i.test(key) && /batch/i.test(key)),
            []
        );
    });
});
