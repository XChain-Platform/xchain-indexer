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
 * XChain shared observability - Prometheus text-format metrics registry
 *
 * A dependency-free implementation of the Prometheus exposition format
 * (text/plain; version=0.0.4). It exists instead of prom-client because every
 * xchain-* service is an independent repo with its own package.json: a shared
 * npm dependency would need publishing and six lockfile bumps, while this file
 * is vendored byte-identically by bin/sync-observability.sh and gated in CI by
 * bin/check-observability-parity.js. Zero deps also means /metrics cannot pull
 * a new supply-chain surface into a consensus-critical service.
 *
 * Cardinality is the failure mode that kills a Prometheus server, so two guards
 * are hard-wired: label names are fixed at declaration time (a metric can never
 * grow a new label at runtime), and each metric caps its distinct label-value
 * series at maxSeries (default 500), after which further series are dropped and
 * counted in xchain_metrics_series_dropped_total rather than silently growing.
 *
 * This module is canonical in xchain-hub. Edit it HERE, then re-run
 * xchain-hub/bin/sync-observability.sh to vendor it into the sibling services.
 *
 ********************************************************************/

'use strict';

// Prometheus name grammars (spec: metric names may contain a colon, label names may not).
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE  = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const DEFAULT_MAX_SERIES = 500;

// Seconds. Tuned for HTTP handlers and RPC calls: sub-millisecond through 10s.
const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeHelp(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

// Prometheus wants Go-style float text: bare integers stay bare, infinities are
// +Inf/-Inf, NaN is NaN. JSON.stringify would emit `null` for those three.
function formatValue(v) {
    if (v === Infinity)  return '+Inf';
    if (v === -Infinity) return '-Inf';
    if (Number.isNaN(v)) return 'NaN';
    return String(v);
}

function assertMetricName(name) {
    if (!METRIC_NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
}

function assertLabelNames(labelNames) {
    for (const l of labelNames) {
        if (!LABEL_NAME_RE.test(l)) throw new Error(`invalid label name: ${l}`);
        // Reserved by the exposition format itself: `le` belongs to histogram
        // buckets and `__name__` is the series identity.
        if (l === '__name__') throw new Error('label name __name__ is reserved');
    }
}

class Metric {
    constructor(type, { name, help, labelNames = [], maxSeries = DEFAULT_MAX_SERIES, registry = null }) {
        assertMetricName(name);
        assertLabelNames(labelNames);
        this.type       = type;
        this.name       = name;
        this.help       = help || name;
        this.labelNames = labelNames.slice();
        this.maxSeries  = maxSeries;
        this.registry   = registry;
        this.series     = new Map();   // labelKey -> { labels, value, ...type state }
    }

    // Series identity is the ordered label-value tuple. Declared order is used
    // (not caller order), so {a,b} and {b,a} address the same series.
    _key(labels) {
        if (this.labelNames.length === 0) return '';
        const parts = [];
        for (const name of this.labelNames) {
            const v = labels[name];
            parts.push(v === undefined || v === null ? '' : String(v));
        }
        return JSON.stringify(parts);
    }

    _normalizeLabels(labels) {
        const out = {};
        for (const name of this.labelNames) {
            const v = labels[name];
            out[name] = v === undefined || v === null ? '' : String(v);
        }
        for (const given of Object.keys(labels)) {
            if (!this.labelNames.includes(given)) {
                throw new Error(`metric ${this.name}: unknown label ${given}`);
            }
        }
        return out;
    }

    // Returns null when the series cap is hit; every mutator treats null as
    // "drop this observation" so a cardinality blowup degrades instead of OOMs.
    _series(labels, makeState) {
        const key = this._key(labels);
        let s = this.series.get(key);
        if (s) return s;
        if (this.series.size >= this.maxSeries) {
            if (this.registry) this.registry._noteSeriesDrop(this.name);
            return null;
        }
        s = { labels: this._normalizeLabels(labels), ...makeState() };
        this.series.set(key, s);
        return s;
    }

    reset() { this.series.clear(); }
}

class Counter extends Metric {
    constructor(opts) { super('counter', opts); }

    inc(labels = {}, value = 1) {
        if (typeof labels === 'number') { value = labels; labels = {}; }
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`counter ${this.name}: inc value must be a non-negative finite number`);
        }
        const s = this._series(labels, () => ({ value: 0 }));
        if (s) s.value += value;
        return s ? s.value : undefined;
    }

    // For collector callbacks that mirror an already-monotonic external source
    // (process.cpuUsage, a driver's lifetime counter). Non-monotonic writes are
    // ignored so a source reset cannot make a counter go backwards mid-scrape.
    setMonotonic(labels, value) {
        if (!Number.isFinite(value) || value < 0) return;
        const s = this._series(labels, () => ({ value: 0 }));
        if (s && value >= s.value) s.value = value;
    }

    get(labels = {}) {
        const s = this.series.get(this._key(labels));
        return s ? s.value : 0;
    }

    samples() {
        const out = [];
        for (const s of this.series.values()) out.push({ name: this.name, labels: s.labels, value: s.value });
        return out;
    }
}

class Gauge extends Metric {
    constructor(opts) { super('gauge', opts); }

    set(labels = {}, value) {
        if (typeof labels === 'number') { value = labels; labels = {}; }
        if (!Number.isFinite(value)) throw new Error(`gauge ${this.name}: set value must be finite`);
        const s = this._series(labels, () => ({ value: 0 }));
        if (s) s.value = value;
    }

    inc(labels = {}, value = 1) {
        if (typeof labels === 'number') { value = labels; labels = {}; }
        const s = this._series(labels, () => ({ value: 0 }));
        if (s) s.value += value;
    }

    dec(labels = {}, value = 1) {
        if (typeof labels === 'number') { value = labels; labels = {}; }
        this.inc(labels, -value);
    }

    get(labels = {}) {
        const s = this.series.get(this._key(labels));
        return s ? s.value : 0;
    }

    samples() {
        const out = [];
        for (const s of this.series.values()) out.push({ name: this.name, labels: s.labels, value: s.value });
        return out;
    }
}

class Histogram extends Metric {
    constructor(opts) {
        super('histogram', opts);
        const buckets = (opts.buckets || DEFAULT_DURATION_BUCKETS).slice().sort((a, b) => a - b);
        if (buckets.some((b) => !Number.isFinite(b))) throw new Error(`histogram ${this.name}: buckets must be finite`);
        if (new Set(buckets).size !== buckets.length) throw new Error(`histogram ${this.name}: duplicate bucket bound`);
        if (this.labelNames.includes('le')) throw new Error(`histogram ${this.name}: 'le' is reserved`);
        this.buckets = buckets;
    }

    observe(labels = {}, value) {
        if (typeof labels === 'number') { value = labels; labels = {}; }
        if (!Number.isFinite(value)) return;
        const s = this._series(labels, () => ({ counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }));
        if (!s) return;
        s.count += 1;
        s.sum   += value;
        for (let i = 0; i < this.buckets.length; i++) {
            if (value <= this.buckets[i]) s.counts[i] += 1;
        }
    }

    // Times a callback (sync or promise) and observes its wall duration in seconds.
    startTimer(labels = {}) {
        const start = process.hrtime.bigint();
        return () => {
            const seconds = Number(process.hrtime.bigint() - start) / 1e9;
            this.observe(labels, seconds);
            return seconds;
        };
    }

    get(labels = {}) {
        const s = this.series.get(this._key(labels));
        return s ? { sum: s.sum, count: s.count, counts: s.counts.slice() } : { sum: 0, count: 0, counts: [] };
    }

    // Bucket samples are CUMULATIVE per the exposition format: each `le` carries
    // the count of observations <= that bound, and +Inf equals _count.
    samples() {
        const out = [];
        for (const s of this.series.values()) {
            // counts[] is already cumulative: observe() bumps every bucket whose
            // bound the value falls under, so no running total is needed here.
            for (let i = 0; i < this.buckets.length; i++) {
                out.push({
                    name: `${this.name}_bucket`,
                    labels: { ...s.labels, le: formatValue(this.buckets[i]) },
                    value: s.counts[i]
                });
            }
            out.push({ name: `${this.name}_bucket`, labels: { ...s.labels, le: '+Inf' }, value: s.count });
            out.push({ name: `${this.name}_sum`,   labels: s.labels, value: s.sum });
            out.push({ name: `${this.name}_count`, labels: s.labels, value: s.count });
        }
        return out;
    }
}

class Registry {
    constructor({ prefix = '', maxSeries = DEFAULT_MAX_SERIES } = {}) {
        this.prefix     = prefix;
        this.maxSeries  = maxSeries;
        this.metrics    = new Map();
        this.collectors = [];
        this.seriesDropped = new Counter({
            name: 'xchain_metrics_series_dropped_total',
            help: 'Observations dropped because a metric hit its per-metric series cap',
            labelNames: ['metric'],
            maxSeries,
            registry: null
        });
        this.metrics.set(this.seriesDropped.name, this.seriesDropped);
    }

    _noteSeriesDrop(metricName) {
        // Guarded: the drop counter itself is capped, and a runaway metric name
        // space must not turn the guard into the leak.
        this.seriesDropped.inc({ metric: metricName }, 1);
    }

    _register(metric) {
        if (this.metrics.has(metric.name)) {
            throw new Error(`metric already registered: ${metric.name}`);
        }
        this.metrics.set(metric.name, metric);
        return metric;
    }

    counter(opts)   { return this._register(new Counter({ maxSeries: this.maxSeries, ...opts, registry: this })); }
    gauge(opts)     { return this._register(new Gauge({ maxSeries: this.maxSeries, ...opts, registry: this })); }
    histogram(opts) { return this._register(new Histogram({ maxSeries: this.maxSeries, ...opts, registry: this })); }

    get(name) { return this.metrics.get(name) || null; }

    // Collectors run synchronously at scrape time for values that are cheap to
    // read on demand (memory, uptime, queue depths). A throwing collector must
    // never fail the scrape: a partial /metrics beats a 500 during an incident.
    addCollector(fn) { this.collectors.push(fn); return fn; }

    render() {
        for (const fn of this.collectors) {
            try { fn(); } catch { /* a broken collector degrades its own metrics only */ }
        }
        const lines = [];
        for (const metric of this.metrics.values()) {
            const samples = metric.samples();
            if (samples.length === 0) continue;
            lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
            lines.push(`# TYPE ${metric.name} ${metric.type}`);
            for (const s of samples) {
                const labelNames = Object.keys(s.labels);
                const labelText = labelNames.length === 0
                    ? ''
                    : `{${labelNames.map((n) => `${n}="${escapeLabelValue(s.labels[n])}"`).join(',')}}`;
                lines.push(`${s.name}${labelText} ${formatValue(s.value)}`);
            }
        }
        // The exposition format requires a trailing newline on the last line.
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    contentType() { return 'text/plain; version=0.0.4; charset=utf-8'; }

    clear() { this.metrics.clear(); this.collectors = []; }
}

// Process and runtime metrics, named to match the prom-client / node_exporter
// conventions so existing Grafana dashboards and alert rules work unchanged.
function collectDefaultMetrics(registry, { service = 'unknown', version = '', coin = '', network = '' } = {}) {
    const startTimeSeconds = Date.now() / 1000 - process.uptime();

    const info = registry.gauge({
        name: 'xchain_service_info',
        help: 'Static service identity; value is always 1',
        labelNames: ['service', 'version', 'coin', 'network', 'node_version']
    });
    info.set({ service, version, coin, network, node_version: process.version }, 1);

    const start = registry.gauge({
        name: 'process_start_time_seconds',
        help: 'Start time of the process since unix epoch in seconds'
    });
    start.set({}, startTimeSeconds);

    const uptime   = registry.gauge({ name: 'process_uptime_seconds',          help: 'Process uptime in seconds' });
    const rss      = registry.gauge({ name: 'process_resident_memory_bytes',   help: 'Resident memory size in bytes' });
    const heapUsed = registry.gauge({ name: 'nodejs_heap_size_used_bytes',     help: 'Used V8 heap size in bytes' });
    const heapTotal= registry.gauge({ name: 'nodejs_heap_size_total_bytes',    help: 'Total V8 heap size in bytes' });
    const external = registry.gauge({ name: 'nodejs_external_memory_bytes',    help: 'V8 external memory in bytes' });
    const handles  = registry.gauge({ name: 'nodejs_active_handles_total',     help: 'Active libuv handles' });
    const cpuUser  = registry.counter({ name: 'process_cpu_user_seconds_total',   help: 'Total user CPU time in seconds' });
    const cpuSys   = registry.counter({ name: 'process_cpu_system_seconds_total', help: 'Total system CPU time in seconds' });

    registry.addCollector(() => {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        uptime.set({}, process.uptime());
        rss.set({}, mem.rss);
        heapUsed.set({}, mem.heapUsed);
        heapTotal.set({}, mem.heapTotal);
        external.set({}, mem.external);
        cpuUser.setMonotonic({}, cpu.user / 1e6);
        cpuSys.setMonotonic({}, cpu.system / 1e6);
        if (typeof process._getActiveHandles === 'function') {
            handles.set({}, process._getActiveHandles().length);
        }
    });

    return registry;
}

module.exports = {
    Registry,
    Counter,
    Gauge,
    Histogram,
    collectDefaultMetrics,
    DEFAULT_DURATION_BUCKETS,
    DEFAULT_MAX_SERIES,
    // exported for the unit suite and for services that build their own names
    escapeLabelValue,
    escapeHelp,
    formatValue,
    METRIC_NAME_RE,
    LABEL_NAME_RE
};
