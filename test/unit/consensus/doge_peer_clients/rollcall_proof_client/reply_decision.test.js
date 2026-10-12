'use strict';

const assert = require('assert');
const {
    decideReply,
    normalizeSigners
} = require('../../../../../src/consensus/doge_peer_clients/rollcall_proof_client/reply_decision.js');

const client = { manifestHash: () => 'mh' };
const request = { epochHeight: 5, maxBlockTime: 100, network: 'regtest' };

function validReply(overrides){
    return Object.assign({
        manifest_hash: 'mh',
        hcut: 10,
        tip_block_index: 1000,
        tip_block_time: 200,
        signers: { alpha: { signature: 'sig', gates: 7 } }
    }, overrides || {});
}

function assertRefusal(result, reason, ask, stubClient){
    const actual = decideReply(stubClient || client, result, ask || request);

    assert.deepStrictEqual(actual, { decided: false, reason });
}

describe('normalizeSigners', function () {
    it('maps non-object rows to null', function () {
        assert.deepStrictEqual(normalizeSigners({ alpha: null, beta: 7, gamma: 'row' }), {
            alpha: null,
            beta: null,
            gamma: null
        });
    });

    it('copies object rows and normalizes gates', function () {
        const raw = {
            alpha: { signature: 'a', gates: 7 },
            beta: { signature: 'b' },
            gamma: { signature: 'c', gates: null }
        };
        const actual = normalizeSigners(raw);

        assert.deepStrictEqual(actual, {
            alpha: { signature: 'a', gates: '7' },
            beta: { signature: 'b', gates: null },
            gamma: { signature: 'c', gates: null }
        });
        assert.notStrictEqual(actual.alpha, raw.alpha);
    });
});

describe('decideReply', function () {
    it('accepts a valid buried reply and normalizes its signers', function () {
        assert.deepStrictEqual(decideReply(client, validReply(), request), {
            decided: true,
            hcut: 10,
            signers: { alpha: { signature: 'sig', gates: '7' } },
            publishers: {}
        });
    });

    it('refuses null and error replies as malformed', function () {
        const reason = 'malformed getrollcallsigners reply';

        assertRefusal(null, reason);
        assertRefusal({ error: 'boom' }, reason);
    });

    it('refuses mismatched and unavailable manifest hashes', function () {
        const reason = 'DOGE indexer action-manifest hash mismatch (stale decoder?)';

        assertRefusal(validReply({ manifest_hash: 'other' }), reason);
        assertRefusal(validReply(), reason, request, { manifestHash: () => null });
    });

    it('refuses a reply without a DOGE window cut', function () {
        assertRefusal(
            validReply({ hcut: null }),
            'no DOGE window cut yet for epoch 5'
        );
    });

    it('refuses a tip at or below the window end', function () {
        const reason = 'DOGE tip has not passed the window end for epoch 5';

        assertRefusal(validReply({ tip_block_time: 100 }), reason);
        assertRefusal(validReply({ tip_block_time: 99 }), reason);
    });

    it('refuses a network without a configured maturity', function () {
        assertRefusal(
            validReply(),
            'unknown network for ROLLCALL_DOGE_MATURITY: nope',
            Object.assign({}, request, { network: 'nope' })
        );
    });

    it('refuses a cut that has not reached regtest maturity', function () {
        assertRefusal(
            validReply({ tip_block_index: 10 }),
            'DOGE cut not buried yet (tip 10 < 12)'
        );
    });
});
