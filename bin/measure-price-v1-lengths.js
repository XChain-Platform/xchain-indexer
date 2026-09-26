#!/usr/bin/env node
/*
 * Measure the PRICE v1 VALUE and FEE string lengths already on chain, read from
 * a public explorer's /{COIN}/api/prices feed, as the input for the canonical
 * length caps. Prints one JSON document; redirect it to keep it.
 *
 * Usage: node bin/measure-price-v1-lengths.js [--base URL]
 */
'use strict';

const COINS = ['BTC', 'LTC', 'DOGE', 'TBTC', 'TLTC', 'TDOGE'];
const DEFAULT_BASE = 'https://explorer.xchain.io';

const VALUE_CANONICAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;
const FEE_CANONICAL   = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
const LEADING_ZERO    = /^0[0-9]/;

function parseBase(argv) {
    const i = argv.indexOf('--base');
    if (i === -1) return DEFAULT_BASE;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error('--base needs a URL');
    return v.replace(/\/+$/, '');
}

async function fetchPage(base, coin, page) {
    const res = await fetch(`${base}/${coin}/api/prices?page=${page}`);
    if (!res.ok) throw new Error(`${coin} page ${page}: HTTP ${res.status}`);
    return res.json();
}

async function readV1Rows(base, coin) {
    const rows = [];
    let seen = 0;
    for (let page = 1; ; page++) {
        const body = await fetchPage(base, coin, page);
        const data = Array.isArray(body.data) ? body.data : [];
        if (data.length === 0) break;
        for (const r of data) if (Number(r.version) === 1) rows.push(r);
        seen += data.length;
        if (seen >= Number(body.total)) break;
    }
    return rows;
}

const longest = (a, b) => Math.max(a, b);

function summarize(rows) {
    const valid = rows.filter((r) => (r.validation_status || r.status) === 'valid');
    const lens = (list, key) => list.map((r) => String(r[key] == null ? '' : r[key]).length);
    const canonV = valid.filter((r) => VALUE_CANONICAL.test(String(r.value)));
    const canonF = valid.filter((r) => r.fee != null && r.fee !== '' && FEE_CANONICAL.test(String(r.fee)));
    return {
        v1_rows: rows.length,
        valid_v1_rows: valid.length,
        longest_valid_value: lens(valid, 'value').reduce(longest, 0),
        longest_valid_fee: lens(valid, 'fee').reduce(longest, 0),
        longest_canonical_value: lens(canonV, 'value').reduce(longest, 0),
        longest_canonical_fee: lens(canonF, 'fee').reduce(longest, 0),
        leading_zero_rows: valid.filter((r) => LEADING_ZERO.test(String(r.value)) || LEADING_ZERO.test(String(r.fee == null ? '' : r.fee))).length,
    };
}

async function main() {
    const base = parseBase(process.argv.slice(2));
    const out = { read_at: new Date().toISOString(), base, chains: {} };
    for (const coin of COINS) out.chains[coin] = summarize(await readV1Rows(base, coin));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(String(e && e.message || e) + '\n'); process.exit(1); });
