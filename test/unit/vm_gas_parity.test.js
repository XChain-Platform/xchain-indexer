// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/* Binds the static native-fee quote to the acceptance fee the handlers charge.
 *
 * The pre-VM protocol fee is charged or quoted at four independent sites: deploy.js,
 * deploy_chunk.js, execute.js, and actions.staticProtocolFee (which sizes the native output
 * a client must build). Computed separately, they agree by inspection only, and nothing fails if one gains a
 * term the others do not - the SDK would quote an output the handler then refuses.
 * The pre-flight drift gate cannot see this class at all: it compares list membership and
 * GAS_SCHEDULE values, never arithmetic.
 *
 * Two guards, because either alone is passable while the defect is live: the fixture parity
 * below proves the numbers agree today, and the source scan proves the arithmetic is still
 * single-sourced tomorrow.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions/index.js');

const SRC = path.join(__dirname, '..', '..', 'src');

// Same schedule shape the feeQuote suite uses, so a value pinned in one reads in the other.
const SCHEDULE = { VM_EXECUTE_BASE: 1000, VM_DEPLOY_BASE: 100000, VM_DEPLOY_PER_BYTE: 10 };

function makeUtil(){
    let util = new Utility();
    util.config['GAS_PRICE']    = '0.00001';
    util.config['GAS_SCHEDULE'] = Object.assign({}, util.config['GAS_SCHEDULE'] || {}, SCHEDULE);
    return util;
}

// The static-quote path with the VM engine and the DB absent: staticProtocolFee reads only
// the schedule, the format version and (for inline DEPLOY) the decoded code bytes.
function makeCtx(util, { base64CodeEra = true } = {}){
    return {
        config:                 util.config,
        util:                   util,
        protocolChanges:        { isEnabled: async (n) => (n === 'DEPLOY_BASE64_CODE' ? base64CodeEra : true) },
        decodeDeployCodeBytes: Actions.prototype.decodeDeployCodeBytes,
        staticProtocolFee:     Actions.prototype.staticProtocolFee
    };
}

describe('static fee quote <-> handler acceptance fee parity @regression @tier1', function () {

    describe('util.vmGasCost() is the one arithmetic', function () {
        const util = makeUtil();

        it('prices each VM gas family off the schedule', function () {
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'EXECUTE', 0), 1000);
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'DEPLOY_INLINE', 1), 100010);
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'DEPLOY_INLINE', 0), 100000);
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'DEPLOY_CHUNKED', 999), 100000,
                'chunked charges base only; its v4 carriers already paid per-byte');
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'DEPLOY_CARRIER', 4), 40);
        });

        it('returns null for an unknown family rather than a free action', function () {
            assert.strictEqual(util.vmGasCost(SCHEDULE, 'NOT_A_FAMILY', 1), null);
        });

        it('never substitutes a default for a missing schedule key', function () {
            // A silent 0 here would price a VM action at nothing. Callers guard on the
            // non-finite result instead (staticProtocolFee returns null, no quote).
            assert.ok(!Number.isFinite(Number(util.vmGasCost({}, 'EXECUTE', 0))));
            assert.ok(!Number.isFinite(Number(util.vmGasCost({}, 'DEPLOY_INLINE', 1))));
            assert.ok(!Number.isFinite(Number(util.vmGasCost({}, 'DEPLOY_CHUNKED', 0))));
            assert.ok(!Number.isFinite(Number(util.vmGasCost({}, 'DEPLOY_CARRIER', 4))));
        });
    });

    describe('the quote reproduces the handler fee from identical fixtures', function () {
        const CODE     = 'x';                                          // 1 byte of source
        const CODE_B64 = Buffer.from(CODE, 'utf8').toString('base64');
        const CARRIER  = 'QUJD';                                       // 4 carried base64 chars

        // Each row: the quote input, and the acceptance-side call the named handler makes for
        // that same transaction. The handler expression is the one the handler now runs
        // (this.util.vmGasCost(schedule, <family>, <bytes>)), so the row is a real comparison
        // of the two paths, not a formula copied out of either.
        const FIXTURES = [
            {
                what:    'EXECUTE (execute.js)',
                action:  'EXECUTE',
                params:  ['0', 'contract1', 'method', 'arg'],
                handler: (u) => u.vmGasCost(SCHEDULE, 'EXECUTE', 0),
                expect:  1000
            },
            {
                what:    'DEPLOY v0 inline (deploy.js, isChunked=false)',
                action:  'DEPLOY',
                params:  ['0', CODE_B64, '500000', ''],
                handler: (u) => u.vmGasCost(SCHEDULE, 'DEPLOY_INLINE', Buffer.byteLength(CODE, 'utf8')),
                expect:  100010
            },
            {
                what:    'DEPLOY v1 inline (deploy.js, isChunked=false)',
                action:  'DEPLOY',
                params:  ['1', CODE_B64, '500000', ''],
                handler: (u) => u.vmGasCost(SCHEDULE, 'DEPLOY_INLINE', Buffer.byteLength(CODE, 'utf8')),
                expect:  100010
            },
            {
                what:    'DEPLOY v2 chunked assembly (deploy.js, isChunked=true)',
                action:  'DEPLOY',
                params:  ['2', 'a'.repeat(64), '500000', ''],
                handler: (u) => u.vmGasCost(SCHEDULE, 'DEPLOY_CHUNKED', 0),
                expect:  100000
            },
            {
                what:    'DEPLOY v3 chunked assembly (deploy.js, isChunked=true)',
                action:  'DEPLOY',
                params:  ['3', 'a'.repeat(64), '500000', ''],
                handler: (u) => u.vmGasCost(SCHEDULE, 'DEPLOY_CHUNKED', 0),
                expect:  100000
            },
            {
                what:    'DEPLOY v4 carrier (deploy_chunk.js)',
                action:  'DEPLOY',
                params:  ['4', 'a'.repeat(64), '0', '2', CARRIER],
                handler: (u) => u.vmGasCost(SCHEDULE, 'DEPLOY_CARRIER', Buffer.byteLength(CARRIER, 'utf8')),
                expect:  40
            }
        ];

        for(const f of FIXTURES){
            it('quote == acceptance fee for ' + f.what, async function () {
                let util  = makeUtil();
                let ctx   = makeCtx(util);
                let quote = await ctx.staticProtocolFee.call(ctx, f.action, f.params, 100);
                assert.ok(quote && !quote.error, 'expected a sized quote, got ' + JSON.stringify(quote));
                assert.strictEqual(quote.gasCost, f.handler(util),
                    'the quoted gas cost must equal what the handler would charge');
                // Pinned as a literal too: an extraction that broke BOTH sides identically
                // would satisfy the equality above and still mis-price the network.
                assert.strictEqual(quote.gasCost, f.expect);
                // bcmul yields a bignumber object, so compare the rendered value, not the handle.
                assert.strictEqual(String(quote.xchainFee),
                    String(util.bcmul(f.handler(util), util.config['GAS_PRICE'], 8)));
            });
        }

        it('the pre-activation hex era bills the same byte count', async function () {
            let util  = makeUtil();
            let ctx   = makeCtx(util, { base64CodeEra: false });
            let quote = await ctx.staticProtocolFee.call(ctx, 'DEPLOY', ['0', '78', '500000', ''], 100);
            assert.strictEqual(quote.gasCost, util.vmGasCost(SCHEDULE, 'DEPLOY_INLINE', 1),
                "hex '78' is the same 1 byte of source the handler would measure");
        });
    });

    const SITES = [
        path.join('actions', 'index.js'),
        path.join('actions', 'deploy', 'index.js'),
        path.join('actions', 'deploy', 'deploy_chunk.js'),
        path.join('actions', 'execute', 'index.js')
    ];
    const GAS_KEY = /VM_DEPLOY_BASE|VM_DEPLOY_PER_BYTE|VM_EXECUTE_BASE/;

    function stripComments(src){
        return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    }

    /* The re-duplication guard, which is the half that survives this commit.
     *
     * Parity fixtures prove the numbers agree today; they say nothing about a future edit that
     * re-inlines the arithmetic into one handler. Charging the VM fee is a per-file property
     * here, so scan the four files: a raw VM_ gas key outside util.vmGasCost means the
     * arithmetic split again and the quote can silently under-size the required output.
     */
    describe('no site recomputes the VM gas arithmetic', function () {
        for(const site of SITES){
            it(site + ' reads no gas-schedule key outside util.vmGasCost', function () {
                const code = stripComments(fs.readFileSync(path.join(SRC, site), 'utf8'));
                const hits = code.split('\n').filter((l) => GAS_KEY.test(l));
                assert.deepStrictEqual(hits, [],
                    site + ' prices VM gas itself again:\n  ' + hits.join('\n  ')
                    + '\n  Route it through this.util.vmGasCost so the static quote moves with it.');
            });
        }
    });

    describe('no site recomputes the VM gas arithmetic', function () {
        // Every .js under src/, relative to it. The SITES list above is the set of files that
        // charge the fee TODAY; it cannot see a fifth handler added tomorrow, and a list that
        // silently covers less than the tree is the same green-by-omission this suite exists
        // to prevent. So the whole tree is scanned and the list stays as an anchor: each entry
        // must still resolve, so a move is reported rather than quietly narrowing the scan.
        function walkJs(dir) {
            const out = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) out.push(...walkJs(abs));
                else if (entry.name.endsWith('.js')) out.push(path.relative(SRC, abs));
            }
            return out;
        }

        // A coin schedule DECLARES the values (`VM_EXECUTE_BASE: 1000,`); it does no arithmetic
        // with them. Only the declaration LINE is exempt, never the file, so a coin that started
        // pricing gas itself is still caught.
        const DECLARATION = /^\s*(?:VM_DEPLOY_BASE|VM_DEPLOY_PER_BYTE|VM_EXECUTE_BASE)\s*:\s*[\d_]+\s*,?\s*$/;

        it('no other file under src/ prices VM gas either', function () {
            const files = walkJs(SRC);
            // The canonical is part of this comparison, not an assumption about it: if
            // utility.js stopped resolving the scan below would exempt a file that is not there.
            assert.ok(files.includes('utility.js'),
                'utility.js, the one arithmetic, no longer resolves under src/; repoint this guard');
            for (const site of SITES)
                assert.ok(files.includes(site),
                    site + ' no longer resolves under src/. Repoint SITES at where the fee is '
                    + 'charged now, so the named-site checks above keep covering it.');
            assert.ok(files.length > SITES.length + 1,
                'the walk found only the files already named; it is no longer scanning the tree');

            const offenders = [];
            for (const rel of files) {
                if (rel === 'utility.js') continue;
                const code = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
                const hits = code.split('\n').filter((l) => GAS_KEY.test(l) && !DECLARATION.test(l));
                if (hits.length) offenders.push(rel + ':\n  ' + hits.join('\n  '));
            }
            assert.deepStrictEqual(offenders, [],
                'these files price VM gas outside util.vmGasCost:\n' + offenders.join('\n')
                + '\n  Route it through this.util.vmGasCost so the static quote moves with it.');
        });

        it('utility.js is the single site that does', function () {
            const code = stripComments(fs.readFileSync(path.join(SRC, 'utility.js'), 'utf8'));
            assert.ok(GAS_KEY.test(code), 'util.vmGasCost is where the arithmetic lives; it went missing');
        });
    });
});
