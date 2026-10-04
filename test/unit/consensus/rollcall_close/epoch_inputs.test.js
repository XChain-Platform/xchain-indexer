'use strict';

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
 *********************************************************************/

const assert = require('assert');
const {
    indexResponsible,
    askSigners
} = require('../../../../src/consensus/rollcall_close/epoch_inputs.js');
const {
    RollcallProofUnavailableError
} = require('../../../../src/consensus/doge_peer_clients/rollcall_proof_client.js');

function fakeProof(answer){
    let calls = [];
    return {
        calls: calls,
        fetchSigners: async (args) => { calls.push(args); return answer; }
    };
}

async function rejection(promise){
    try { await promise; } catch(e){ return e; }
    return null;
}

describe('rollcall_close epoch_inputs', () => {
    describe('indexResponsible', () => {
        it('lower-cases keys in order and maps each to its source', () => {
            let out = indexResponsible([
                { pubkey: 'AA', source: 's1' },
                { pubkey: 'Bb', source: 's1' },
                { pubkey: 'cc', source: 's2' }
            ]);
            assert.deepStrictEqual(out.keys, ['aa', 'bb', 'cc']);
            assert.deepStrictEqual([...out.sourceOf], [['aa', 's1'], ['bb', 's1'], ['cc', 's2']]);
            assert.deepStrictEqual([...out.allSources].sort(), ['s1', 's2']);
            assert.strictEqual(out.allSources.size, 2);
        });

        it('gives empty keys, map and set for an empty list', () => {
            let out = indexResponsible([]);
            assert.deepStrictEqual(out.keys, []);
            assert.strictEqual(out.sourceOf.size, 0);
            assert.strictEqual(out.allSources.size, 0);
        });
    });

    describe('askSigners', () => {
        it('asks once with the leader as publisher and returns a decided answer', async () => {
            let answer = { decided: true, signers: ['k'] };
            let proof = fakeProof(answer);
            let out = await askSigners(proof, 5, 99, ['k'], 'L');
            assert.strictEqual(out, answer);
            assert.deepStrictEqual(proof.calls, [
                { epochHeight: 5, maxBlockTime: 99, pubkeys: ['k'], publishers: ['L'] }
            ]);
        });

        it('sends no publishers when the leader is falsy', async () => {
            let proof = fakeProof({ decided: true });
            await askSigners(proof, 5, 99, ['k'], null);
            assert.deepStrictEqual(proof.calls[0].publishers, []);
        });

        it('throws with the reason when the answer is undecided', async () => {
            let err = await rejection(askSigners(fakeProof({ decided: false, reason: 'r' }), 5, 99, ['k'], 'L'));
            assert.ok(err instanceof RollcallProofUnavailableError);
            assert.strictEqual(err.message, 'epoch 5 undecidable: r');
        });

        it('throws "no answer" when the answer is null', async () => {
            let err = await rejection(askSigners(fakeProof(null), 5, 99, ['k'], 'L'));
            assert.ok(err instanceof RollcallProofUnavailableError);
            assert.strictEqual(err.message, 'epoch 5 undecidable: no answer');
        });
    });
});
