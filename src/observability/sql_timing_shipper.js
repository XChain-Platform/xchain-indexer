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
 * XChain shared observability - SQL timing sender
 *
 * Buffers normalized timing contract lines and posts bounded NDJSON batches
 * to Prometheus. The API key is confined to the request header.
 *
 ********************************************************************/

'use strict';

const MAX_BATCH_LINES = 2000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

function toBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validHttpsUrl(value) {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/**
 * Reads SQL timing configuration without exposing the API key.
 *
 * @param {object} env environment bag
 * @returns {object} validated sender configuration
 */
function readSqlTimingEnv(env = process.env) {
    const url = String(env.SQL_TIMING_URL || '').trim();
    const apiKey = String(env.SQL_TIMING_KEY || '');
    const project = String(env.SQL_TIMING_PROJECT || '').trim();
    const configured = validHttpsUrl(url) && apiKey.length > 0 && project.length > 0;
    return {
        enabled: toBool(env.SQL_TIMING_ENABLED, false) && configured,
        url: validHttpsUrl(url) ? url : '',
        apiKey,
        project,
        intervalMs: toPositiveInt(env.SQL_TIMING_INTERVAL_MS, 60000),
        maxBuffer: toPositiveInt(env.SQL_TIMING_MAX_BUFFER, 20000)
    };
}

function releaseBody(response) {
    const body = response && response.body;
    if (!body || typeof body.cancel !== 'function') return Promise.resolve();
    return Promise.resolve(body.cancel()).catch(() => {});
}

class SqlTimingShipper {
    /**
     * Creates an inert or active SQL timing sender from an env bag.
     *
     * @param {object} opts sender options
     */
    constructor({ env = process.env, registry = null, transport = null, console: sink = console } = {}) {
        this.config = readSqlTimingEnv(env);
        this.console = sink;
        this.buffer = [];
        this.timer = null;
        this.inFlight = false;
        this.pending = null;
        this.lastErrorNoteMs = 0;
        this.stats = { shipped: 0, dropped: 0, failures: 0 };
        this.transport = transport || ((request) => this._post(request));
        if (registry) this._attachMetrics(registry);
        if (this.config.enabled) this._startTimer();
    }

    _attachMetrics(registry) {
        const shipped = registry.counter({
            name: 'sql_timing_lines_shipped_total',
            help: 'SQL timing contract lines successfully shipped'
        });
        const dropped = registry.counter({
            name: 'sql_timing_lines_dropped_total',
            help: 'SQL timing contract lines dropped from the bounded buffer'
        });
        const failures = registry.counter({
            name: 'sql_timing_ship_failures_total',
            help: 'Failed SQL timing batch attempts'
        });
        registry.addCollector(() => {
            shipped.setMonotonic({}, this.stats.shipped);
            dropped.setMonotonic({}, this.stats.dropped);
            failures.setMonotonic({}, this.stats.failures);
        });
    }

    _startTimer() {
        this.timer = setInterval(() => { this.flush(); }, this.config.intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /**
     * Adds one serialized contract line to the bounded queue.
     *
     * @param {string|object} line contract line or record
     * @returns {boolean} whether the line was accepted
     */
    enqueue(line) {
        if (!this.config.enabled) return false;
        let serialized;
        try { serialized = typeof line === 'string' ? line : JSON.stringify(line); } catch { return false; }
        if (!serialized || /[\r\n]/.test(serialized)) return false;
        if (this.buffer.length >= this.config.maxBuffer) {
            this.buffer.shift();
            this.stats.dropped += 1;
        }
        this.buffer.push(serialized);
        return true;
    }

    _takeBatch() {
        let bytes = 0;
        let count = 0;
        while (count < this.buffer.length && count < MAX_BATCH_LINES) {
            const lineBytes = Buffer.byteLength(this.buffer[count]) + 1;
            if (count > 0 && bytes + lineBytes > MAX_BATCH_BYTES) break;
            if (count === 0 && lineBytes > MAX_BATCH_BYTES) {
                this.buffer.shift();
                this.stats.dropped += 1;
                continue;
            }
            bytes += lineBytes;
            count += 1;
        }
        return this.buffer.splice(0, count);
    }

    _requeue(batch) {
        const room = Math.max(0, this.config.maxBuffer - this.buffer.length);
        const keep = batch.slice(Math.max(0, batch.length - room));
        this.stats.dropped += batch.length - keep.length;
        this.buffer.unshift(...keep);
    }

    /**
     * Sends at most one bounded batch and resolves after its disposition.
     *
     * @returns {Promise<void>} current send attempt
     */
    flush() {
        if (this.inFlight) return this.pending || Promise.resolve();
        if (!this.config.enabled || this.buffer.length === 0) return Promise.resolve();
        const batch = this._takeBatch();
        if (batch.length === 0) return Promise.resolve();
        const request = {
            url: this.config.url,
            headers: {
                'Content-Type': 'application/x-ndjson',
                'X-Prometheus-Api-Key': this.config.apiKey
            },
            body: `${batch.join('\n')}\n`
        };
        this.inFlight = true;
        this.pending = Promise.resolve()
            .then(() => this.transport(request))
            .then((result) => this._handleResult(result, batch))
            .catch(() => {
                this.stats.failures += 1;
                this._requeue(batch);
                this._noteError(new Error('transport error'));
            })
            .finally(() => {
                this.inFlight = false;
                this.pending = null;
            });
        return this.pending;
    }

    _handleResult(result, batch) {
        const status = Number(result && result.status);
        if (status >= 200 && status < 300) {
            this.stats.shipped += batch.length;
            return;
        }
        this.stats.failures += 1;
        if (status === 429 || status >= 500 || !Number.isFinite(status)) this._requeue(batch);
        else this.stats.dropped += batch.length;
        this._noteError(new Error(Number.isFinite(status) ? `intake responded ${status}` : 'intake response invalid'));
    }

    _noteError(error) {
        try {
            const now = Date.now();
            if (now - this.lastErrorNoteMs < 60000) return;
            this.lastErrorNoteMs = now;
            const write = this.console.error || this.console.log;
            if (!write) return;
            const reason = error && error.message ? error.message : 'unknown';
            write.call(this.console, `[sql-timing] batch failed (${reason}); buffered=${this.buffer.length} dropped=${this.stats.dropped}`);
        } catch { /* Keep sender diagnostics fail-open. */ }
    }

    _post(request) {
        return fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: request.body
        }).then((response) => releaseBody(response).then(() => ({ status: response.status })));
    }

    /** Stops the interval and performs one final send attempt. */
    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.flush();
    }
}

/** Creates a SQL timing sender. */
function createSqlTimingShipper(opts = {}) { return new SqlTimingShipper(opts); }

module.exports = {
    SqlTimingShipper,
    createSqlTimingShipper,
    readSqlTimingEnv,
    MAX_BATCH_LINES,
    MAX_BATCH_BYTES
};
