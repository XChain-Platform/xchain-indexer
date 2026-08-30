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
 * XChain Indexer - failure-leg diagnostics
 *
 * Two indexer faults leave a durable record that nothing watches and a console
 * line that reads exactly like a success.
 *
 * A cross-chain call refused for want of quorum writes a row to
 * cross_chain_call_rejections. That table is node-local, never replicated, and
 * consulted only when somebody asks getcrosschaincallresult about that one
 * call: a starved dispatch retries every block forever and no operator learns
 * of it until a user reports the call never arrived.
 *
 * A rejected ANCHOR prints through the same console.log as an accepted one, so
 * a checkpoint bundle the whole federation refused is one word different from a
 * bundle that landed, at the same level, in the same shape.
 *
 * This module turns both into events a collector can key on. Emission is
 * through the shim's getLogger() rather than console because a patched console
 * line cannot carry structured fields, and the fields are the point: a reader
 * needs the call, the chain and the reason, not prose. Every emit is guarded,
 * so a diagnostic can never throw into the path it observes.
 *
 ********************************************************************/

'use strict';

const { getLogger, getRegistry } = require('./observability');

let _counters = null;

function counters() {
    if (!_counters) {
        const registry = getRegistry();
        _counters = {
            crashes: registry.counter({
                name: 'xchain_crashes_total',
                help: 'Uncaught exceptions and unhandled rejections',
                labelNames: ['kind']
            })
        };
    }
    return _counters;
}

/**
 * Record a cross-chain call refused at injection.
 *
 * @param {object} d
 * @param {string} d.call_id  the dispatch this refusal is about
 * @param {string} d.reason   machine-readable refusal class, e.g. quorum_not_met
 * @param {string} [d.detail] human detail, already truncated by the caller
 * @param {number} [d.block_index] block the refusal was evaluated at
 */
function noteXcallRejected({ call_id, reason, ...extra } = {}) {
    const fields = { call_id: String(call_id || 'unknown'), reason: String(reason || 'unknown') };
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) fields[k] = v;
    }
    try { return getLogger().warn('XCALL_REJECTED', fields); }
    catch { return null; }
}

/**
 * Record an ANCHOR the parser refused.
 *
 * @param {object} d
 * @param {string} d.chain   checkpointed chain, or the comma list a v0 bundle covers
 * @param {string} d.reason  the stored verdict, e.g. 'invalid: SECTION 0 SIG_COUNT'
 */
function noteAnchorFailed({ chain, reason, ...extra } = {}) {
    const fields = { chain: String(chain || 'unknown'), reason: String(reason || 'unknown') };
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) fields[k] = v;
    }
    try { return getLogger().warn('ANCHOR_FAILED', fields); }
    catch { return null; }
}

// The verdicts anchor.js stores are free text, but every refusal is prefixed
// 'invalid'. 'unverified' and 'orphan' are NOT refusals: they mark an anchor a
// snapshot-less node cannot judge yet and a chunk that arrived before its head,
// both of which resolve on their own.
function isAnchorFailureStatus(status) {
    return String(status || '').startsWith('invalid');
}

/**
 * Install process-level crash handlers.
 *
 * The indexer has neither handler today, so a throw outside a promise chain
 * kills the block loop with node's default stderr dump: no level, no service
 * tag, nothing a collector can key on.
 *
 * @param {object} [opts]
 * @param {object} [opts.proc]              process-like target, for tests
 * @param {boolean} [opts.exitOnUncaught=true]
 */
function installCrashHandlers({ proc = process, exitOnUncaught = true } = {}) {
    const emit = (kind, err) => {
        try { counters().crashes.inc({ kind }, 1); } catch { /* never mask the crash */ }
        try {
            getLogger().error('CRASH', {
                kind,
                err: err && err.message ? err.message : String(err),
                stack: err && err.stack ? err.stack : undefined
            });
        } catch { /* never mask the crash */ }
    };

    proc.on('uncaughtException', (err) => {
        emit('uncaughtException', err);
        // Process state after an uncaught throw is unknown: the block loop may
        // hold an open MariaDB transaction and half-applied in-memory state, so
        // this exits for a supervised restart rather than indexing on from it.
        if (exitOnUncaught) proc.exit(1);
    });

    proc.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        emit('unhandledRejection', err);
    });
}

// Tests only: the counter handles are process-wide.
function _resetDiagnostics() {
    _counters = null;
}

module.exports = {
    noteXcallRejected,
    noteAnchorFailed,
    isAnchorFailureStatus,
    installCrashHandlers,
    _resetDiagnostics
};
