/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * CORS_ORIGIN is an ALLOWLIST, and the load-bearing assertions are the ones
 * that drive the real `cors` middleware rather than reading parseCorsOrigin's
 * return value.
 *
 * The defect this guards against is not a crash, it is a header that LOOKS
 * configured: handed a String, `cors` echoes it verbatim to every caller, so
 * `CORS_ORIGIN="a,b"` answers `Access-Control-Allow-Origin: a,b` to a, to b,
 * and to a hostile origin alike. No browser accepts a multi-value ACAO, so
 * every listed shell is blocked while `curl -D -` shows a populated header.
 * Asserting on the parse function alone would not have caught that; asserting
 * on what a caller receives is the only thing that does. Twin of the encoder,
 * hub, and utxo-tracker suites.
 *
 **********************************************************************/

'use strict'

const assert  = require('assert')
const express = require('express')
const cors    = require('cors')
const { parseCorsOrigin } = require('../../src/corsOrigin.js')

// The indexer's unset default, preserved by the fix: an operator who never set
// CORS_ORIGIN keeps the localhost grant they had before.
const DEFAULT_ORIGIN = 'http://localhost'

// Mount cors exactly as src/api.js does, default and `methods` included, and ask
// what a browser would receive. The JSON-RPC surface is POST, so probe with POST.
async function acaoFor (rawEnv, origins) {
    const app = express()
    app.use(cors({ origin: parseCorsOrigin(rawEnv || DEFAULT_ORIGIN), methods: ['POST'] }))
    app.post('/probe', (req, res) => res.json({ ok: true }))

    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s))
    })
    try {
        const port = server.address().port
        const out = {}
        for (const origin of origins) {
            const res = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', headers: { Origin: origin } })
            out[origin] = res.headers.get('access-control-allow-origin')
        }
        return out
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

// The browser surfaces that read the indexer cross-origin: the hosted explorer
// and the wallet shells (iOS falls to Capacitor's default `capacitor://localhost`,
// Android sends `https://localhost`).
const IOS      = 'capacitor://localhost'
const ANDROID  = 'https://localhost'
const EXPLORER = 'https://explorer.xchain.io'
const HOSTILE  = 'https://evil.example'

describe('CORS_ORIGIN allowlist parsing', function () {

    describe('parseCorsOrigin', function () {

        it('disables CORS when the var is unset, empty, blank, or only separators', function () {
            assert.strictEqual(parseCorsOrigin(undefined), false)
            assert.strictEqual(parseCorsOrigin(null), false)
            assert.strictEqual(parseCorsOrigin(''), false)
            assert.strictEqual(parseCorsOrigin('   '), false)
            assert.strictEqual(parseCorsOrigin(',,'), false)
            assert.strictEqual(parseCorsOrigin(' , , '), false)
        })

        it('passes a lone value straight through, so `*` and a single origin behave as before', function () {
            assert.strictEqual(parseCorsOrigin('*'), '*')
            assert.strictEqual(parseCorsOrigin(EXPLORER), EXPLORER)
            assert.strictEqual(parseCorsOrigin(`  ${EXPLORER}  `), EXPLORER)
        })

        it('splits a comma-separated value into an array and trims each entry', function () {
            assert.deepStrictEqual(parseCorsOrigin(`${IOS},${ANDROID},${EXPLORER}`), [IOS, ANDROID, EXPLORER])
            assert.deepStrictEqual(parseCorsOrigin(` ${IOS} , ${ANDROID} `), [IOS, ANDROID])
            assert.deepStrictEqual(parseCorsOrigin(`${IOS},,${EXPLORER}`), [IOS, EXPLORER])
        })
    })

    describe('what a caller actually receives', function () {

        // Behaviour preservation, not a new grant: the pre-fix mount also named
        // http://localhost to every caller when the var was unset.
        it('keeps the unset default at http://localhost', async function () {
            const acao = await acaoFor(undefined, [EXPLORER, HOSTILE])
            assert.strictEqual(acao[EXPLORER], DEFAULT_ORIGIN)
            assert.strictEqual(acao[HOSTILE], DEFAULT_ORIGIN)
        })

        it('sends `*` to everyone when CORS_ORIGIN is `*`', async function () {
            const acao = await acaoFor('*', [IOS, EXPLORER, HOSTILE])
            assert.strictEqual(acao[IOS], '*')
            assert.strictEqual(acao[EXPLORER], '*')
            assert.strictEqual(acao[HOSTILE], '*')
        })

        // Measured, not assumed: given a String, `cors` does no matching at all -
        // it names that origin to every caller, and the BROWSER is what refuses a
        // mismatch. That is safe for one origin and is exactly why a comma list is
        // not: the same unconditional echo produces a header nobody can accept.
        it('names the single configured origin to every caller, leaving the browser to refuse', async function () {
            const acao = await acaoFor(EXPLORER, [EXPLORER, IOS, HOSTILE])
            assert.strictEqual(acao[EXPLORER], EXPLORER)
            assert.strictEqual(acao[IOS], EXPLORER)
            assert.strictEqual(acao[HOSTILE], EXPLORER)
        })

        // The allowlist form is strictly stronger: an unlisted origin is refused at
        // the SERVER, without a header, rather than relying on the browser.
        it('refuses an unlisted origin server-side once the value is a list', async function () {
            const acao = await acaoFor(`${IOS},${EXPLORER}`, [HOSTILE])
            assert.strictEqual(acao[HOSTILE], null)
        })

        // THE REGRESSION. Before parseCorsOrigin every one of these read back the
        // raw "a,b,c" string, including for HOSTILE.
        it('echoes each allowlisted origin BACK TO ITSELF, never the raw list', async function () {
            const raw  = `${IOS},${ANDROID},${EXPLORER}`
            const acao = await acaoFor(raw, [IOS, ANDROID, EXPLORER, HOSTILE])

            assert.strictEqual(acao[IOS], IOS)
            assert.strictEqual(acao[ANDROID], ANDROID)
            assert.strictEqual(acao[EXPLORER], EXPLORER)
            assert.strictEqual(acao[HOSTILE], null)

            // Stated separately because this is the exact shape of the old bug:
            // a header that is present and populated and accepted by nothing.
            for (const origin of [IOS, ANDROID, EXPLORER]) {
                assert.notStrictEqual(acao[origin], raw,
                    'a multi-value ACAO is rejected by every browser; the header must name one origin')
                assert.ok(!String(acao[origin]).includes(','),
                    'ACAO must never contain a comma')
            }
        })

        it('fails CLOSED on `*` mixed with real origins rather than silently opening up', async function () {
            const acao = await acaoFor(`*,${EXPLORER}`, [EXPLORER, HOSTILE])
            assert.strictEqual(acao[EXPLORER], EXPLORER)
            assert.strictEqual(acao[HOSTILE], null,
                'a stray `*` in a list must not widen the grant to every origin')
        })
    })

    // The parser is only reached if api.js actually calls it. Asserting the source
    // line keeps a later edit from reverting to the raw env var while every
    // behavioural test above still passes against the helper in isolation.
    describe('src/api.js wiring', function () {

        it('mounts cors through parseCorsOrigin, never the raw env var', function () {
            const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/api.js'), 'utf8')
            assert.ok(/origin:\s*parseCorsOrigin\(process\.env\.CORS_ORIGIN \|\| 'http:\/\/localhost'\)/.test(src),
                "api.js must mount cors with parseCorsOrigin(process.env.CORS_ORIGIN || 'http://localhost')")
            assert.ok(!/origin:\s*process\.env\.CORS_ORIGIN/.test(src),
                'api.js must not hand the raw CORS_ORIGIN string to cors')
        })
    })
})
