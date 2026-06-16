'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const fs = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../results');

class ReportGenerator {

    constructor(opts = {}) {
        this.outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
        this.writeFiles = opts.writeFiles !== false;
    }

    printSummary(stats) {
        const bar = '='.repeat(70);
        const dash = '-'.repeat(70);
        console.log('');
        console.log(bar);
        console.log(` Perf Report: ${stats.name}`);
        console.log(bar);
        console.log(` Blocks processed : ${stats.totalBlocks} (${stats.warmupBlocks} warmup, ${stats.measuredBlocks} measured)`);
        console.log(` Duration         : ${stats.durationMs.toLocaleString()} ms`);
        console.log(` Throughput       : ${stats.throughput.blocksPerSecond} blocks/sec`);
        console.log(dash);

        console.log(` Block timing (ms)  min      avg      p50      p95      p99      max`);
        const bt = stats.blockTiming;
        console.log(`   Total         ${this._pad(bt.min)}${this._pad(bt.avg)}${this._pad(bt.p50)}${this._pad(bt.p95)}${this._pad(bt.p99)}${this._pad(bt.max)}`);
        console.log(dash);

        console.log(` Phase timing (ms)  avg      p95`);
        for (const [name, pt] of Object.entries(stats.phaseTiming)) {
            console.log(`   ${name.padEnd(18)}${this._pad(pt.avg)}${this._pad(pt.p95)}`);
        }
        console.log(dash);

        const m = stats.memory;
        console.log(` Memory (MB)      initial   peak     final    growth`);
        console.log(`   heapUsed    ${this._pad(m.initialHeapMb)}${this._pad(m.peakHeapMb)}${this._pad(m.finalHeapMb)}${this._pad(m.heapGrowthMb)}`);
        console.log(dash);

        const el = stats.eventLoop;
        console.log(` Event Loop (ms)  mean     p95      p99      max`);
        console.log(`                ${this._pad(el.meanMs)}${this._pad(el.p95Ms)}${this._pad(el.p99Ms)}${this._pad(el.maxMs)}`);
        console.log(dash);

        console.log(` Errors: ${stats.errors.length}`);
        if (stats.errors.length > 0) {
            for (const e of stats.errors.slice(0, 5)) {
                console.log(`   Block ${e.blockIndex}: ${e.message}`);
            }
        }
        console.log(bar);
        console.log('');
    }

    writeJson(stats, filename) {
        if (!this.writeFiles) return;
        this._ensureDir();
        const data = {
            generated: new Date().toISOString(),
            nodeVersion: process.version,
            platform: process.platform,
            stats: { ...stats, _rawBlockTimings: undefined }
        };
        const filePath = path.join(this.outputDir, `${filename}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    writeMarkdown(stats, filename) {
        if (!this.writeFiles) return;
        this._ensureDir();
        const lines = [];
        lines.push(`# Performance Report: ${stats.name}`);
        lines.push('');
        lines.push(`Generated: ${new Date().toISOString()}  `);
        lines.push(`Node: ${process.version} | Platform: ${process.platform}`);
        lines.push('');
        lines.push('## Summary');
        lines.push('');
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Blocks processed | ${stats.totalBlocks} (${stats.warmupBlocks} warmup) |`);
        lines.push(`| Duration | ${stats.durationMs.toLocaleString()} ms |`);
        lines.push(`| Throughput | ${stats.throughput.blocksPerSecond} blocks/sec |`);
        lines.push('');

        lines.push('## Block Timing (ms)');
        lines.push('');
        lines.push('| Metric | min | avg | p50 | p95 | p99 | max |');
        lines.push('|---|---|---|---|---|---|---|');
        const bt = stats.blockTiming;
        lines.push(`| Total | ${bt.min} | ${bt.avg} | ${bt.p50} | ${bt.p95} | ${bt.p99} | ${bt.max} |`);
        lines.push('');

        lines.push('## Phase Breakdown (ms)');
        lines.push('');
        lines.push('| Phase | avg | p50 | p95 | p99 |');
        lines.push('|---|---|---|---|---|');
        for (const [name, pt] of Object.entries(stats.phaseTiming)) {
            lines.push(`| ${name} | ${pt.avg} | ${pt.p50} | ${pt.p95} | ${pt.p99} |`);
        }
        lines.push('');

        lines.push('## Memory');
        lines.push('');
        const m = stats.memory;
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Initial heap | ${m.initialHeapMb} MB |`);
        lines.push(`| Peak heap | ${m.peakHeapMb} MB |`);
        lines.push(`| Final heap | ${m.finalHeapMb} MB |`);
        lines.push(`| Heap growth | ${m.heapGrowthMb} MB |`);
        lines.push('');

        lines.push('## Event Loop Delay');
        lines.push('');
        const el = stats.eventLoop;
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Mean | ${el.meanMs} ms |`);
        lines.push(`| p95 | ${el.p95Ms} ms |`);
        lines.push(`| p99 | ${el.p99Ms} ms |`);
        lines.push(`| Max | ${el.maxMs} ms |`);
        lines.push('');

        if (stats.errors.length > 0) {
            lines.push('## Errors');
            lines.push('');
            for (const e of stats.errors) {
                lines.push(`- Block ${e.blockIndex}: ${e.message}`);
            }
            lines.push('');
        }

        const filePath = path.join(this.outputDir, `${filename}.md`);
        fs.writeFileSync(filePath, lines.join('\n'));
    }

    generateAll(stats, baseName) {
        this.printSummary(stats);
        this.writeJson(stats, baseName);
        this.writeMarkdown(stats, baseName);
    }

    _pad(val, width = 9) {
        return String(val != null ? val : '-').padStart(width);
    }

    _ensureDir() {
        fs.mkdirSync(this.outputDir, { recursive: true });
    }
}

module.exports = ReportGenerator;
