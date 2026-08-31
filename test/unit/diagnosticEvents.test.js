// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Row 4 of the proactive-system-watch spec: the indexer's failure legs.
//
// Each case drives the REAL site (the rejection writer, the crash handlers)
// rather than calling the emitter directly, because the claim under test is
// that the site is wired, not that the emitter works.

const assert        = require('assert');
const { EventEmitter } = require('events');

const diag          = require('../../src/diagnosticEvents.js');
const observability = require('../../src/observability');
const XChainDB      = require('../../src/db.js');

describe('indexer failure-leg diagnostics @regression', function () {

    let sink;

    // Records, not printed lines: getLogger() routes to whatever shipper the
    // process installed, so a capture sink on that shipper sees the fields.
    function lines(event) {
        return sink.lines.filter(l => l.includes(event));
    }
    function crashCount(kind) {
        const line = observability.getRegistry().render().split('\n')
            .find(l => l.startsWith(`xchain_crashes_total{kind="${kind}"}`));
        return line ? Number(line.trim().split(' ').pop()) : 0;
    }

    beforeEach(function () {
        observability._resetObservability();
        diag._resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-indexer', env: {}, console: { log: push, warn: push, error: push }
        });
    });

    afterEach(function () {
        observability._resetObservability();
        diag._resetDiagnostics();
    });

    describe('XCALL_REJECTED', function () {

        // The real writer, with only the SQL round trip replaced: the assertion is
        // that recording a refusal emits, not that MariaDB accepts the statement.
        function dbWithFakeQuery() {
            const db = Object.create(XChainDB.prototype);
            db.doQuery = async () => [];
            return db;
        }

        it('a recorded cross-chain refusal emits the call and the reason', async function () {
            const db = dbWithFakeQuery();
            await db.recordCrossChainCallRejection(
                'AABBCC', 'quorum_not_met', 'insufficient valid signatures (1/3)', 4211);

            const emitted = lines('XCALL_REJECTED');
            assert.strictEqual(emitted.length, 1);
            assert.ok(emitted[0].includes('call_id=aabbcc'), emitted[0]);
            assert.ok(emitted[0].includes('reason=quorum_not_met'), emitted[0]);
            assert.ok(emitted[0].includes('block_index=4211'), emitted[0]);
        });

        it('a null detail is omitted rather than emitted as the string null', async function () {
            const db = dbWithFakeQuery();
            await db.recordCrossChainCallRejection('dd', 'quorum_not_met', null, 7);
            assert.ok(!lines('XCALL_REJECTED')[0].includes('detail='), lines('XCALL_REJECTED')[0]);
        });

        it('clearing a refusal emits nothing: only the failure leg is an event', async function () {
            const db = dbWithFakeQuery();
            await db.clearCrossChainCallRejection('aabbcc');
            assert.strictEqual(lines('XCALL_REJECTED').length, 0);
        });

        it('a broken logger cannot break the write it observes', async function () {
            const db = dbWithFakeQuery();
            observability._resetObservability();   // getLogger() has no shipper behind it
            await db.recordCrossChainCallRejection('ee', 'quorum_not_met', 'x', 1);
        });
    });

    describe('isAnchorFailureStatus', function () {
        it('treats only the invalid verdicts as failures', function () {
            assert.strictEqual(diag.isAnchorFailureStatus('invalid: SECTION 0 SIG_COUNT'), true);
            assert.strictEqual(diag.isAnchorFailureStatus('invalid_archive'), true);
            assert.strictEqual(diag.isAnchorFailureStatus('valid'), false);
            // A node with no mirrored snapshot cannot judge the anchor yet, and a
            // chunk that landed before its head resolves when the head arrives.
            assert.strictEqual(diag.isAnchorFailureStatus('unverified'), false);
            assert.strictEqual(diag.isAnchorFailureStatus('orphan'), false);
            assert.strictEqual(diag.isAnchorFailureStatus(undefined), false);
        });
    });

    describe('CRASH handlers', function () {

        // A stand-in process, so the real handlers run without mocha's own
        // handlers or a live process.exit taking part.
        function fakeProc() {
            const proc = new EventEmitter();
            proc.exits = [];
            proc.exit = (code) => proc.exits.push(code);
            return proc;
        }

        it('an uncaught exception emits one CRASH record and exits non-zero', function () {
            const proc = fakeProc();
            diag.installCrashHandlers({ proc });

            proc.emit('uncaughtException', new Error('probe-uncaught'));

            const emitted = lines('CRASH');
            assert.strictEqual(emitted.length, 1);
            assert.ok(emitted[0].includes('kind=uncaughtException'), emitted[0]);
            assert.ok(emitted[0].includes('probe-uncaught'), emitted[0]);
            assert.deepStrictEqual(proc.exits, [1]);
            assert.strictEqual(crashCount('uncaughtException'), 1);
        });

        it('an unhandled rejection emits CRASH and lets the process continue', function () {
            const proc = fakeProc();
            diag.installCrashHandlers({ proc });

            proc.emit('unhandledRejection', new Error('probe-rejection'));

            const emitted = lines('CRASH');
            assert.strictEqual(emitted.length, 1);
            assert.ok(emitted[0].includes('kind=unhandledRejection'), emitted[0]);
            assert.deepStrictEqual(proc.exits, [], 'a stray promise does not by itself corrupt shared state');
            assert.strictEqual(crashCount('unhandledRejection'), 1);
        });

        it('a non-Error rejection reason still yields a readable record', function () {
            const proc = fakeProc();
            diag.installCrashHandlers({ proc });
            proc.emit('unhandledRejection', 'plain string reason');
            assert.ok(lines('CRASH')[0].includes('plain string reason'), lines('CRASH')[0]);
        });

        it('a broken logger cannot swallow the exit', function () {
            const proc = fakeProc();
            diag.installCrashHandlers({ proc });
            observability._resetObservability();
            proc.emit('uncaughtException', new Error('probe-no-sink'));
            assert.deepStrictEqual(proc.exits, [1]);
        });
    });
});
