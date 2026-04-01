'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

class MetricsCollector {

    constructor(opts = {}) {
        this.name = opts.name || 'unnamed';
        this.warmupBlocks = opts.warmupBlocks || 0;
        this.elDelayResolution = opts.elDelayResolution || 20;

        this.blockTimings = [];
        this.memSnapshots = [];
        this.errors = [];
        this.startWallTime = null;
        this.elMonitor = null;
        this._blockStart = null;
    }

    start() {
        this.blockTimings = [];
        this.memSnapshots = [];
        this.errors = [];
        this.startWallTime = Date.now();
        this.elMonitor = monitorEventLoopDelay({ resolution: this.elDelayResolution });
        this.elMonitor.enable();
    }

    stop() {
        if (this.elMonitor) this.elMonitor.disable();
    }

    beginBlock(blockIndex) {
        this._blockStart = process.hrtime.bigint();
        this._currentBlock = blockIndex;
    }

    endBlock(blockIndex, phaseTimings) {
        const totalMs = Number(process.hrtime.bigint() - this._blockStart) / 1e6;
        const mem = process.memoryUsage();
        this.blockTimings.push({ blockIndex, totalMs, phases: phaseTimings });
        this.memSnapshots.push({
            blockIndex,
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external
        });
    }

    recordError(blockIndex, error) {
        this.errors.push({
            blockIndex,
            message: error && error.message ? error.message : String(error)
        });
    }

    getRawTimings() {
        return this.blockTimings.map(b => b.totalMs);
    }

    getStats() {
        const durationMs = Date.now() - this.startWallTime;
        const measured = this.blockTimings.slice(this.warmupBlocks);
        const totalBlocks = this.blockTimings.length;

        // Block timing stats
        const times = measured.map(b => b.totalMs);
        const blockTiming = this._computeDistribution(times);

        // Phase timing stats
        const phaseNames = ['decoderRead', 'actionProcessing', 'expirations',
                            'cancellations', 'blockCreation', 'marketUpdates',
                            'sanityCheck', 'commit'];
        const phaseTiming = {};
        for (const name of phaseNames) {
            const vals = measured.map(b => (b.phases && b.phases[name]) || 0);
            phaseTiming[name] = this._computeDistribution(vals);
        }

        // Memory stats
        const heaps = this.memSnapshots.map(s => s.heapUsed);
        const memory = {
            initialHeapMb: heaps.length > 0 ? (heaps[0] / 1048576).toFixed(1) : 0,
            finalHeapMb: heaps.length > 0 ? (heaps[heaps.length - 1] / 1048576).toFixed(1) : 0,
            peakHeapMb: heaps.length > 0 ? (Math.max(...heaps) / 1048576).toFixed(1) : 0,
            heapGrowthMb: heaps.length > 1
                ? ((heaps[heaps.length - 1] - heaps[0]) / 1048576).toFixed(1)
                : 0
        };

        // Event loop delay stats
        const eventLoop = {};
        if (this.elMonitor) {
            eventLoop.meanMs = +(this.elMonitor.mean / 1e6).toFixed(2);
            eventLoop.p95Ms = +(this.elMonitor.percentile(95) / 1e6).toFixed(2);
            eventLoop.p99Ms = +(this.elMonitor.percentile(99) / 1e6).toFixed(2);
            eventLoop.maxMs = +(this.elMonitor.max / 1e6).toFixed(2);
        }

        return {
            name: this.name,
            totalBlocks,
            warmupBlocks: this.warmupBlocks,
            measuredBlocks: measured.length,
            durationMs,
            throughput: {
                blocksPerSecond: totalBlocks > 0 ? +(totalBlocks / (durationMs / 1000)).toFixed(2) : 0
            },
            blockTiming,
            phaseTiming,
            memory,
            eventLoop,
            errors: this.errors,
            _rawBlockTimings: times
        };
    }

    getSummary() {
        const s = this.getStats();
        return `[${s.name}] ${s.totalBlocks} blocks in ${s.durationMs}ms ` +
            `(${s.throughput.blocksPerSecond} blk/s) | ` +
            `avg: ${s.blockTiming.avg}ms | p95: ${s.blockTiming.p95}ms | p99: ${s.blockTiming.p99}ms | ` +
            `heap: ${s.memory.heapGrowthMb > 0 ? '+' : ''}${s.memory.heapGrowthMb} MB | ` +
            `EL p99: ${s.eventLoop.p99Ms || 0}ms | errors: ${s.errors.length}`;
    }

    _computeDistribution(values) {
        if (values.length === 0) {
            return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
        }
        const sorted = [...values].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        return {
            min: +sorted[0].toFixed(2),
            max: +sorted[sorted.length - 1].toFixed(2),
            avg: +(sum / sorted.length).toFixed(2),
            p50: +this._percentile(sorted, 50).toFixed(2),
            p95: +this._percentile(sorted, 95).toFixed(2),
            p99: +this._percentile(sorted, 99).toFixed(2)
        };
    }

    _percentile(sorted, p) {
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    }
}

module.exports = MetricsCollector;
