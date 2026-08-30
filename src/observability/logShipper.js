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
 * XChain shared observability - structured log shim and shipper
 *
 * The fleet logs to per-box stdout with no aggregation, so an incident means
 * SSHing to each host. This shim is the in-tree half of the fix: it turns log
 * calls into one-line NDJSON records (ts, level, service, msg, fields) and can
 * optionally POST batches of those lines to a collector (Loki/Vector/Fluent
 * Bit all accept NDJSON over HTTP). The collector itself is an ops rollout,
 * deliberately not part of this change.
 *
 * Three properties are non-negotiable because this sits under every service:
 *
 *   1. Default-inert. With no env set, log lines go to the same console the
 *      service already used, in the same plain text. Nothing buffers, nothing
 *      dials out. Shipping needs BOTH the flag and a URL.
 *   2. Never throws, never blocks. A dead collector must not take down a
 *      consensus service, so the buffer is bounded (oldest dropped, drops
 *      counted) and every transport error is swallowed into a counter with a
 *      rate-limited stderr note.
 *   3. Secret-safe. Field keys that look credential-bearing are redacted
 *      before serialization, and the message text is scrubbed of `key=value`
 *      credential pairs. Shipping logs off-box is exactly where a leaked
 *      password becomes a third party's problem.
 *
 * This module is canonical in xchain-hub. Edit it HERE, then re-run
 * xchain-hub/bin/sync-observability.sh to vendor it into the sibling services.
 *
 ********************************************************************/

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Key names whose values never leave the box in a log line.
const SECRET_KEY_RE = /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|auth|credential|wif|priv(ate)?[_-]?key|mnemonic|seed|cookie|session)/i;

// `password=hunter2`, `api_key: abc`, `token="x"`, `HUB_DB_SECRET=...` embedded
// in free text.
//
// The key is allowed to carry a prefix and a suffix, and the leading boundary is
// "not preceded by another key character" rather than `\b`. `\b` does not fire
// between two word characters, and `_` is a word character, so an anchored
// pattern silently misses every env-shaped name the services actually print:
// `HUB_DB_SECRET`, `INDEXER_DB_PASS`, `db_password`. Those are precisely what an
// env-validation failure puts on stdout, and with LOG_SHIP_* on they would go
// off-box in the clear.
const SECRET_INLINE_RE = /(?<![A-Za-z0-9])([A-Za-z0-9_]*(?:pass(?:word|phrase|wd)?|secret|token|api[_-]?key|apikey|authorization|credential|wif|priv(?:ate)?[_-]?key|mnemonic|seed)[A-Za-z0-9_]*\s*[:=]\s*)(?:bearer\s+)?("[^"]*"|'[^']*'|\S+)/gi;

// A bearer token with no key in front of it, as a header line is usually quoted.
// The `authorization: Bearer x` shape is handled above, where the value group
// would otherwise capture the word "Bearer" and leave the token in the clear.
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;

const REDACTED = '[redacted]';

// Deliberately NOT swept here: bare hex. Hub and indexer lines are full of
// legitimate 64-char hex (txids, block hashes, state roots, digests) and
// redacting those would gut the logs this spec exists to make readable. The
// watch collector applies a hex-key sweep at its own boundary instead, where the
// output is a committed report rather than an operator's live tail.
function scrubMessage(msg) {
    return String(msg)
        .replace(SECRET_INLINE_RE, (_m, keyAndSep) => `${keyAndSep}${REDACTED}`)
        .replace(BEARER_RE, REDACTED);
}

// Envelope keys are rendered as the line's own prefix, so they never repeat in
// the key=value tail.
const ENVELOPE_KEYS = new Set(['ts', 'level', 'service', 'msg', 'version']);

// A bare token only where it cannot be confused with the next pair: anything
// carrying whitespace, `=` or a quote is JSON-quoted so a reader can split the
// tail on unquoted spaces. This is the half of the text format the watch
// collector's parser is written against (claude/scripts/xchain-watch.js).
function formatFieldValue(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') {
        return value !== '' && !/[\s"'=]/.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    let json;
    try { json = JSON.stringify(value); } catch { json = '"[unserializable]"'; }
    if (json === undefined) json = 'null';
    return /[\s]/.test(json) ? JSON.stringify(json) : json;
}

/**
 * Renders a record as the fleet's default text line:
 *
 *     <iso-ts> <level> [<service>] <msg> key=value key=value
 *
 * The message stays immediately after the service tag so every existing
 * substring grep across the platform (handover greps, StatusService, the
 * decoder's wait loops) keeps matching: the prefix is the only addition. The level token is lowercase on purpose: an uppercase ERROR would
 * be counted by the server-monitor's `grep -cE 'ERROR|FATAL'` rate alert on
 * every console.error line and page the fleet on first deploy.
 */
function formatTextLine(record) {
    let line = `${record.ts} ${record.level} [${record.service}] ${record.msg}`;
    for (const [k, v] of Object.entries(record)) {
        if (ENVELOPE_KEYS.has(k) || v === undefined) continue;
        line += ` ${String(k).replace(/[\s"'=]/g, '_')}=${formatFieldValue(v)}`;
    }
    return line;
}

// Depth-limited so a cyclic or huge object cannot stall the hot path; anything
// past the limit becomes a type marker rather than being walked.
function redactFields(value, depth = 0, seen = new Set()) {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 4) return '[truncated]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactFields(v, depth + 1, seen));
    if (value instanceof Error) {
        return { name: value.name, message: scrubMessage(value.message), stack: value.stack ? scrubMessage(value.stack) : undefined };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactFields(v, depth + 1, seen);
    }
    return out;
}

function toBool(v, fallback = false) {
    if (v === undefined || v === null || v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(v));
}

function toInt(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reads the log-shim config off an env bag. Shipping stays off unless
 * LOG_SHIP_ENABLED is truthy AND LOG_SHIP_URL is a parseable http(s) URL, so a
 * half-configured box logs normally instead of buffering into nothing.
 */
function readLogEnv(env = process.env) {
    const url = (env.LOG_SHIP_URL || '').trim();
    let urlOk = false;
    if (url) {
        try {
            const parsed = new URL(url);
            urlOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch { urlOk = false; }
    }
    return {
        format:      /^json$/i.test(env.LOG_FORMAT || '') ? 'json' : 'text',
        level:       (env.LOG_LEVEL || 'info').toLowerCase() in LEVELS ? (env.LOG_LEVEL || 'info').toLowerCase() : 'info',
        shipEnabled: toBool(env.LOG_SHIP_ENABLED, false) && urlOk,
        url:         urlOk ? url : '',
        // LOG_SHIP_TOKEN is read here and never logged, never echoed, and never
        // put in an error message; only the Authorization header sees it.
        token:       env.LOG_SHIP_TOKEN || '',
        batchSize:   toInt(env.LOG_SHIP_BATCH_SIZE, 100),
        intervalMs:  toInt(env.LOG_SHIP_INTERVAL_MS, 5000),
        maxBuffer:   toInt(env.LOG_SHIP_MAX_BUFFER, 5000),
        timeoutMs:   toInt(env.LOG_SHIP_TIMEOUT_MS, 5000)
    };
}

class LogShipper {
    /**
     * @param {object}   opts
     * @param {string}   opts.service   service name stamped on every record
     * @param {object}   opts.env       env bag (defaults to process.env)
     * @param {object}   opts.console   console-like sink for local output
     * @param {function} opts.transport async (ndjsonBody) => void; injected in tests
     * @param {object}   opts.registry  metrics Registry; shipper counters attach to it
     */
    constructor({ service = 'unknown', version = '', env = process.env, console: sink = console, transport = null, registry = null } = {}) {
        this.service = service;
        this.version = version;
        this.config  = readLogEnv(env);
        this.console = sink;
        this.buffer  = [];
        this.timer   = null;
        this.stopped = false;
        this.inFlight = false;
        this.pending  = null;
        this.lastErrorNoteMs = 0;
        this.stats = { emitted: 0, shipped: 0, dropped: 0, failures: 0 };
        this.transport = transport || ((body) => this._post(body));
        if (registry) this._attachMetrics(registry);
        if (this.config.shipEnabled) this._startTimer();
    }

    _attachMetrics(registry) {
        const emitted = registry.counter({ name: 'log_lines_emitted_total', help: 'Log lines emitted by the structured log shim', labelNames: ['level'] });
        // Cumulative totals are counters, not gauges: a _total-suffixed gauge
        // reads to a scraper as a resettable level, so rate() over it is
        // undefined. setMonotonic publishes the running total and refuses a
        // backwards step, which is what a restarted source would otherwise do.
        const shipped = registry.counter({ name: 'log_lines_shipped_total',   help: 'Log lines successfully shipped to the collector' });
        const dropped = registry.counter({ name: 'log_lines_dropped_total',   help: 'Log lines dropped because the ship buffer was full' });
        const failed  = registry.counter({ name: 'log_ship_failures_total',   help: 'Failed log-ship batch attempts' });
        // Buffer depth IS a level, so it stays a gauge.
        const pending = registry.gauge({ name: 'log_ship_buffer_lines',     help: 'Log lines currently buffered for shipping' });
        this._levelCounter = emitted;
        registry.addCollector(() => {
            shipped.setMonotonic({}, this.stats.shipped);
            dropped.setMonotonic({}, this.stats.dropped);
            failed.setMonotonic({}, this.stats.failures);
            pending.set({}, this.buffer.length);
        });
    }

    _startTimer() {
        this.timer = setInterval(() => { this.flush(); }, this.config.intervalMs);
        // A logging timer must never be the reason the process refuses to exit.
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    log(level, msg, fields = {}) {
        if (!(level in LEVELS)) level = 'info';
        if (LEVELS[level] < LEVELS[this.config.level]) return null;

        let safeFields = redactFields(fields);
        if (!safeFields || typeof safeFields !== 'object' || Array.isArray(safeFields)) safeFields = {};
        // Envelope keys are stripped from caller fields so a field named `level`
        // or `service` can never forge the identity of a record.
        for (const reserved of ['ts', 'level', 'service', 'msg', 'version']) delete safeFields[reserved];

        const record = { ts: new Date().toISOString(), level, service: this.service, msg: scrubMessage(msg) };
        if (this.version) record.version = this.version;
        Object.assign(record, safeFields);

        this.stats.emitted += 1;
        if (this._levelCounter) this._levelCounter.inc({ level }, 1);
        this._emitLocal(level, record);
        if (this.config.shipEnabled) this._enqueue(record);
        return record;
    }

    debug(msg, fields) { return this.log('debug', msg, fields); }
    info(msg, fields)  { return this.log('info',  msg, fields); }
    warn(msg, fields)  { return this.log('warn',  msg, fields); }
    error(msg, fields) { return this.log('error', msg, fields); }

    _emitLocal(level, record) {
        const fn = level === 'error' ? (this.console.error || this.console.log)
            : level === 'warn' ? (this.console.warn || this.console.log)
                : this.console.log;
        if (!fn) return;
        // Both modes carry the same record. Printing only the scrubbed message
        // here would discard every field, and the fleet runs text mode, so the
        // fields would exist nowhere an operator can reach.
        if (this.config.format === 'json') fn.call(this.console, JSON.stringify(record));
        else fn.call(this.console, formatTextLine(record));
    }

    _enqueue(record) {
        if (this.buffer.length >= this.config.maxBuffer) {
            // Drop oldest: during an incident the newest lines are the ones worth having.
            this.buffer.shift();
            this.stats.dropped += 1;
        }
        this.buffer.push(record);
        if (this.buffer.length >= this.config.batchSize) this.flush();
    }

    // Fire-and-forget by design: callers never await logging. Returns the
    // in-flight promise so tests (and shutdown) can settle it.
    flush() {
        // A pending batch is returned rather than ignored so stop() and tests can
        // settle the send that a batch-size trigger already started.
        if (this.inFlight) return this.pending || Promise.resolve();
        if (this.buffer.length === 0 || !this.config.shipEnabled) return Promise.resolve();
        const batch = this.buffer.splice(0, this.config.batchSize);
        const body  = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
        this.inFlight = true;
        this.pending = Promise.resolve()
            .then(() => this.transport(body))
            .then(() => { this.stats.shipped += batch.length; })
            .catch((err) => {
                this.stats.failures += 1;
                // Re-queue at the FRONT so a transient collector outage does not
                // reorder the stream, but never past the buffer cap.
                const room = Math.max(0, this.config.maxBuffer - this.buffer.length);
                const keep = batch.slice(Math.max(0, batch.length - room));
                this.stats.dropped += batch.length - keep.length;
                this.buffer.unshift(...keep);
                this._noteError(err);
            })
            .finally(() => { this.inFlight = false; this.pending = null; });
        return this.pending;
    }

    // At most one stderr line per minute: a collector outage must not itself
    // become the log flood that fills the disk.
    _noteError(err) {
        const now = Date.now();
        if (now - this.lastErrorNoteMs < 60000) return;
        this.lastErrorNoteMs = now;
        const sink = this.console.error || this.console.log;
        if (sink) sink.call(this.console, `[log-ship] batch failed (${err && err.message ? err.message : 'unknown'}); buffered=${this.buffer.length} dropped=${this.stats.dropped}`);
    }

    _post(body) {
        const { url, token, timeoutMs } = this.config;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers = { 'Content-Type': 'application/x-ndjson' };
        if (token) headers.Authorization = `Bearer ${token}`;
        return fetch(url, { method: 'POST', headers, body, signal: controller.signal })
            .then((res) => {
                if (!res.ok) throw new Error(`collector responded ${res.status}`);
            })
            .finally(() => clearTimeout(timer));
    }

    async stop() {
        this.stopped = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.config.shipEnabled) await this.flush();
    }
}

function createLogShipper(opts = {}) { return new LogShipper(opts); }

module.exports = {
    LogShipper, createLogShipper, readLogEnv, redactFields, scrubMessage,
    formatTextLine, formatFieldValue, LEVELS, REDACTED,
    SECRET_KEY_RE, SECRET_INLINE_RE
};
