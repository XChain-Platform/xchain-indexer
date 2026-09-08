/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The ROLLCALL proof client's deferral rule.
 *
 * Every case here is an ambiguity that MUST resolve to "not decided". The
 * asymmetry is the point: an absence is an eviction, so a wrong "nobody signed"
 * costs a live validator its stake, while a deferral costs a block that will be
 * retried. A test that only proved the happy path would certify nothing, so the
 * happy path is one case out of many here and every other case is a refusal.
 *
 ********************************************************************/
const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { RollcallProofClient, RollcallProofUnavailableError } = require('../../src/rollcall_proof_client.js');

const CONFIG   = { COIN: 'BTC', NETWORK: 'regtest' };
const EPOCH    = 30;
const MAXT     = 1000;
const MATURITY = 2;   // ROLLCALL_DOGE_MATURITY.regtest

function realManifestHash(){
    return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '../../test/fixtures/action-manifest.json')))
        .digest('hex');
}

// A client whose transport is replaced by a canned reply (or a thrown error).
function clientWith(reply, opts){
    let c = new RollcallProofClient(CONFIG, Object.assign({ url: 'http://doge.invalid/' }, opts || {}));
    c._rpc = async () => {
        if(reply instanceof Error) throw reply;
        return reply;
    };
    return c;
}

// A well-formed, buried, matching-manifest answer: the ONLY shape that decides.
function goodReply(over){
    return Object.assign({
        hcut:            50,
        tip_block_index: 50 + MATURITY,
        tip_block_time:  MAXT + 1,
        manifest_hash:   realManifestHash(),
        signers:         {},
        publishers:      {}
    }, over || {});
}

const ask = { epochHeight: EPOCH, maxBlockTime: MAXT, pubkeys: ['aa'.repeat(32)], publishers: ['bb'.repeat(32)] };

describe('rollcall_proof_client', function () {

    it('decides on a well-formed, buried, manifest-matching answer', async function () {
        let r = await clientWith(goodReply()).fetchSigners(ask);
        assert.strictEqual(r.decided, true, r.reason);
        assert.strictEqual(r.hcut, 50);
    });

    // (1) unconfigured
    it('defers when no DOGE indexer is configured', async function () {
        let c = new RollcallProofClient(CONFIG, { url: '' });
        let r = await c.fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /not configured/i);
    });

    // (1) unreachable
    it('defers when the peer is unreachable, and never reads a timeout as "nobody signed"', async function () {
        let r = await clientWith(new Error('Request timeout')).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /unreachable/i);
    });

    // (2) malformed
    it('defers on a malformed reply', async function () {
        for(const bad of [null, undefined, {}, { error: 'nope' }, { signers: null }, { signers: 'not-an-object' }]){
            let r = await clientWith(bad).fetchSigners(ask);
            assert.strictEqual(r.decided, false, 'should have deferred on ' + JSON.stringify(bad));
        }
    });

    // (5) manifest mismatch -- checked BEFORE emptiness can be mistaken for information
    it('defers when the peer\'s action-manifest hash differs, which is the stale-decoder signal', async function () {
        let r = await clientWith(goodReply({ manifest_hash: 'f'.repeat(64) })).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /manifest/i);
    });

    it('defers when the peer reports no manifest hash at all', async function () {
        let r = await clientWith(goodReply({ manifest_hash: null })).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
    });

    // (3) no cut yet
    it('defers on a null hcut rather than reading empty signers as a positive "none"', async function () {
        let r = await clientWith(goodReply({ hcut: null })).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /cut/i);
    });

    it('defers when the DOGE tip has not passed the window end', async function () {
        let r = await clientWith(goodReply({ tip_block_time: MAXT })).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /window end/i);
    });

    // (4) not buried
    it('defers when the cut is not yet buried by ROLLCALL_DOGE_MATURITY', async function () {
        let r = await clientWith(goodReply({ tip_block_index: 50 + MATURITY - 1 })).fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /buried/i);
    });

    it('decides at exactly the maturity boundary, not one block later', async function () {
        let r = await clientWith(goodReply({ tip_block_index: 50 + MATURITY })).fetchSigners(ask);
        assert.strictEqual(r.decided, true, r.reason);
    });

    it('defers on an unknown network rather than treating the maturity as zero', async function () {
        let c = clientWith(goodReply());
        c.config = { COIN: 'BTC', NETWORK: 'bogusnet' };
        let r = await c.fetchSigners(ask);
        assert.strictEqual(r.decided, false);
        assert.match(r.reason, /ROLLCALL_DOGE_MATURITY/);
    });

    // An EMPTY answer under a satisfied gate is a real "none", not a deferral: that
    // is what lets a genuinely absent federation close an epoch unrolled.
    it('treats an empty signer map under a satisfied gate as a positive "none"', async function () {
        let r = await clientWith(goodReply({ signers: {}, publishers: {} })).fetchSigners(ask);
        assert.strictEqual(r.decided, true, r.reason);
        assert.deepStrictEqual(r.signers, {});
    });

    it('memoizes a DECIDED answer but never an unknown', async function () {
        // Decided: second call must not re-ask.
        let calls = 0;
        let c = new RollcallProofClient(CONFIG, { url: 'http://doge.invalid/' });
        c._rpc = async () => { calls++; return goodReply(); };
        await c.fetchSigners(ask);
        await c.fetchSigners(ask);
        assert.strictEqual(calls, 1, 'a decided answer should be memoized');

        // Unknown: it is exactly the state expected to change, so it must be re-asked.
        let calls2 = 0;
        let c2 = new RollcallProofClient(CONFIG, { url: 'http://doge.invalid/' });
        c2._rpc = async () => { calls2++; return goodReply({ hcut: null }); };
        await c2.fetchSigners(ask);
        await c2.fetchSigners(ask);
        assert.strictEqual(calls2, 2, 'an unknown must NOT be memoized');
    });

    // ROLLCALL v1: the close chooses which canonical it verifies against by whether
    // the row carries a GATES string, so the field has to survive the transport with
    // "absent" and "present" still distinguishable.
    describe('the ROLLCALL v1 GATES passthrough', function () {

        const KEY   = 'aa'.repeat(32);
        const GATES = 'anchor_reward_activation.ANCHOR_REWARD_ACTIVATION,rollcall_activation.ROLLCALL_ACTIVATION';

        function signerRow(over){
            return Object.assign({
                sig: '11'.repeat(64), ledger_hash: 'cd'.repeat(32), publisher: KEY,
                action_index: 1, block_index: 10
            }, over || {});
        }

        it('carries the GATES string through untouched', async function () {
            let r = await clientWith(goodReply({ signers: { [KEY]: signerRow({ gates: GATES }) } })).fetchSigners(ask);
            assert.strictEqual(r.decided, true, r.reason);
            assert.strictEqual(r.signers[KEY].gates, GATES);
            // Every other field of the row is passed through unchanged.
            assert.strictEqual(r.signers[KEY].sig, '11'.repeat(64));
            assert.strictEqual(r.signers[KEY].ledger_hash, 'cd'.repeat(32));
            assert.strictEqual(r.signers[KEY].block_index, 10);
        });

        it('spells a v0 row\'s missing GATES as an explicit null, never undefined', async function () {
            // A peer that predates v1 answers without the key at all. The close reads
            // null as "v0 row"; undefined would work by accident today and stop working
            // the moment anything asks for the field by name.
            let r = await clientWith(goodReply({ signers: { [KEY]: signerRow() } })).fetchSigners(ask);
            assert.strictEqual(r.decided, true, r.reason);
            assert.ok('gates' in r.signers[KEY], 'the field must be present');
            assert.strictEqual(r.signers[KEY].gates, null);
        });

        it('passes a null GATES through as null', async function () {
            let r = await clientWith(goodReply({ signers: { [KEY]: signerRow({ gates: null }) } })).fetchSigners(ask);
            assert.strictEqual(r.signers[KEY].gates, null);
        });

        it('keeps a key with no in-window row as null, not as a row shape', async function () {
            let r = await clientWith(goodReply({ signers: { [KEY]: null } })).fetchSigners(ask);
            assert.strictEqual(r.decided, true, r.reason);
            assert.strictEqual(r.signers[KEY], null);
        });

        it('reads a non-object row as absent rather than handing the close a string', async function () {
            let r = await clientWith(goodReply({ signers: { [KEY]: 'garbage' } })).fetchSigners(ask);
            assert.strictEqual(r.decided, true, r.reason);
            assert.strictEqual(r.signers[KEY], null);
        });
    });

    it('exports its own error class, distinct from the anchor rail\'s', function () {
        let e = new RollcallProofUnavailableError('x');
        assert.strictEqual(e.name, 'RollcallProofUnavailableError');
        assert.ok(e instanceof Error);
    });
});
