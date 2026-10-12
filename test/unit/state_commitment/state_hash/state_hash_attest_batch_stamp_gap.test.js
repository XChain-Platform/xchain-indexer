/*
 * The attest batch head re-stamp gap, closed by the flag-day state-hash class.
 * On regtest the class is armed from genesis, so the surviving v5 batch head
 * stamp now reaches the preimage through its own read beside the v0 class.
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

describe('state_hash attest batch head stamp gap closed @regression', () => {
    it('reads the surviving v5 batch head stamp into the preimage once the class is armed', async function(){
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

        // The v0 request_status read stays, and the head class adds exactly one more.
        assert.strictEqual(attestReads.length, 2, 'the v0 request_status class and the batch head class read attests');
        assert.strictEqual(attestReads.filter(sql => /\bWHERE\s+version\s*=\s*0\b/i.test(sql)).length, 1);
        assert.deepStrictEqual(data.request_status.attests, []);
        assert.deepStrictEqual(data.attest_batch_head, []);
    });
});
