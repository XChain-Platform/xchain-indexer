/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Unit tests: genesis XCP/XDP airdrop pass (src/genesis.js, ).
 *
 * The airdrop leg credits the CP/DP native-token allocation to snapshot
 * holders pro-rata inside each configured bucket. These tests pin its
 * consensus-relevant properties with a mock action pipeline (no MariaDB):
 *   - disabled-by-default: no buckets configured, no credit actions;
 *   - deterministic action shape/order and synthetic tx-hash uniqueness;
 *   - pro-rata math floors at 8 decimals and never over-mints a bucket;
 *   - fail-closed config: missing amount, missing file, or a pinned-hash
 *     mismatch throws BEFORE any credit is injected;
 *   - snapshot hygiene: duplicate addresses sum, junk quantities skip.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const Genesis = require('../../src/genesis');
const Utility = require('../../src/utility');

const GAS_ADDR = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';
const util     = new Utility({});

let counter = 0;
function tmpFile(content){
    let file = path.join(os.tmpdir(), `xchain-airdrop-unit-${process.pid}-${counter++}.csv`);
    fs.writeFileSync(file, content);
    return file;
}
function sha256(file){
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Build a Genesis wired to a recording mock pipeline. `airdrop` = { paths, hashes, amounts }.
function build(airdrop, cfgOverride){
    let calls   = [];
    let actions = { processTransaction: async (tx, isGenesis) => { calls.push({ tx, isGenesis }); } };
    let config  = Object.assign({
        COIN:                            'BTC',
        NETWORK:                         'regtest',
        GAS:                             'XCHAIN',
        ADDRESS:                         { GAS: GAS_ADDR },
        MAX_TICK_LENGTH:                 250,
        GENESIS_BLOCK:                   100,
        GENESIS_LEDGER_HASH:             null,
        GENESIS_LEDGER_PATH:             tmpFile('tick,owner_address\nAAA,1owner\n'),
        GENESIS_DUMP_PATH:               path.join(os.tmpdir(), 'nonexistent-genesis-dump.ndjson.gz'),
        GENESIS_AIRDROP_PATHS:           (airdrop && airdrop.paths)   || [],
        GENESIS_AIRDROP_HASHES:          (airdrop && airdrop.hashes)  || [],
        GENESIS_AIRDROP_AMOUNTS:         (airdrop && airdrop.amounts) || [],
        GENESIS_AIRDROP_SNAPSHOT_BLOCK:  '901290',
    }, cfgOverride || {});
    let genesis = new Genesis(actions, {}, config, util);
    return { genesis, calls, config };
}

// Recompute the combined set-hash the way an operator arming a bucket set has to:
// `NAME:hash:amount` per bucket, newline-joined, in canonical (name byte-order) order.
// Written independently of src/genesis.js on purpose - it is the pinned wire form, so a
// test that called the implementation could not catch the format changing under it.
function setHash(airdrop){
    let lines = airdrop.paths
        .map((p, i) => ({
            name:   path.basename(p).replace(/\.[^.]*$/, '').toUpperCase(),
            hash:   (airdrop.hashes || [])[i] || 'unpinned',
            amount: airdrop.amounts[i],
        }))
        .sort((a, b) => a.name < b.name ? -1 : 1)
        .map(b => b.name + ':' + b.hash + ':' + b.amount);
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Split the recorded calls into ledger-name actions and airdrop credits by hash marker.
function credits(calls){
    return calls.filter(c => c.tx.tx_hash.startsWith('GENESIS-BTC-A-'));
}

describe('genesis airdrop pass ', function(){

    it('is disabled by default: no buckets, no credit actions', async function(){
        let { genesis, calls } = build(null);
        await genesis.inject(100, 1700000000);
        assert.strictEqual(credits(calls).length, 0);
        assert.ok(calls.length > 0, 'name/gas-token injection still ran');
    });

    it('credits holders pro-rata, in file order, via ISSUE format 2 with MINT_SUPPLY + TRANSFER_SUPPLY', async function(){
        let file = tmpFile('address,quantity\naddr1,1\naddr2,2\naddr3,1\n');
        let { genesis, calls } = build({ paths: [file], hashes: [sha256(file)], amounts: ['100'] });
        await genesis.inject(100, 1700000000);

        let c = credits(calls);
        assert.strictEqual(c.length, 3);
        assert.deepStrictEqual(
            c.map(x => x.tx.data),
            ['ISSUE|2|XCHAIN||25.00000000|addr1',
             'ISSUE|2|XCHAIN||50.00000000|addr2',
             'ISSUE|2|XCHAIN||25.00000000|addr3']);
        // Credits ride the genesis pipeline (fee-exempt, address-format exempt).
        assert.ok(c.every(x => x.isGenesis === true));
        assert.ok(c.every(x => x.tx.source === GAS_ADDR));
        assert.ok(c.every(x => x.tx.block_index === 100));
        // Airdrop runs AFTER the gas token + name passes.
        assert.ok(calls.findIndex(x => x.tx.tx_hash.includes('-GAS-')) < calls.indexOf(c[0]));
        // Synthetic hashes: unique, deterministic, and within the 64-char indexed width.
        let hashes = c.map(x => x.tx.tx_hash);
        assert.strictEqual(new Set(hashes).size, hashes.length);
        assert.ok(hashes.every(h => h.length <= 64));
        let expected = 'GENESIS-BTC-A-' + crypto.createHash('sha256')
            .update('BTC|AIRDROP|' + path.basename(file).replace(/\.[^.]*$/, '').toUpperCase() + '|addr1')
            .digest('hex').slice(0, 48);
        assert.strictEqual(hashes[0], expected);
    });

    it('floors each credit at 8 decimals so a bucket never over-mints', async function(){
        let file = tmpFile('addr1,1\naddr2,1\naddr3,1\n');
        let { genesis, calls } = build({ paths: [file], hashes: [''], amounts: ['10'] });
        await genesis.inject(100, 1700000000);
        let c = credits(calls);
        assert.strictEqual(c.length, 3);
        let sum = '0';
        for(let x of c){
            let mintSupply = x.tx.data.split('|')[4];
            assert.strictEqual(mintSupply, '3.33333333'); // floored, not banker's-rounded
            sum = util.bcadd(sum, mintSupply, 8);
        }
        assert.ok(!util.bcgt(sum, '10'), 'minted sum must be <= the bucket amount');
    });

    it('supports multiple buckets with independent amounts and skips zero-floor credits', async function(){
        let xcp = tmpFile('addr1,999999999\naddr2,0.00000001\n'); // addr2 floors to zero
        let xdp = tmpFile('daddr1,3\n');
        let { genesis, calls } = build({
            paths:   [xcp, xdp],
            hashes:  [sha256(xcp), sha256(xdp)],
            amounts: ['30', '70'],
        });
        await genesis.inject(100, 1700000000);
        let c = credits(calls);
        assert.strictEqual(c.length, 2); // addr2's dust share floored to 0 and was skipped
        assert.strictEqual(c[0].tx.data.split('|')[5], 'addr1');
        assert.strictEqual(c[1].tx.data, 'ISSUE|2|XCHAIN||70.00000000|daddr1');
    });

    it('sums duplicate addresses and skips junk quantities', async function(){
        let file = tmpFile('addr1,1\naddr2,junk\naddr3,-5\naddr1,1\naddr4,2\n');
        let { genesis, calls } = build({ paths: [file], hashes: [''], amounts: ['4'] });
        await genesis.inject(100, 1700000000);
        let c = credits(calls);
        assert.deepStrictEqual(
            c.map(x => x.tx.data),
            ['ISSUE|2|XCHAIN||2.00000000|addr1',   // 1 + 1 summed, first-seen order kept
             'ISSUE|2|XCHAIN||2.00000000|addr4']);
    });

    it('fails closed on a pinned-hash mismatch BEFORE any credit is injected', async function(){
        let file = tmpFile('addr1,1\n');
        let { genesis, calls } = build({ paths: [file], hashes: ['0'.repeat(64)], amounts: ['10'] });
        await assert.rejects(() => genesis.inject(100, 1700000000), /airdrop snapshot hash mismatch/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('fails closed when a bucket amount is missing or invalid', async function(){
        let file = tmpFile('addr1,1\n');
        for(let amounts of [[], [''], ['0'], ['-5'], ['1.000000001']]){
            let { genesis } = build({ paths: [file], hashes: [''], amounts });
            await assert.rejects(() => genesis.inject(100, 1700000000), /GENESIS FATAL/);
        }
    });

    it('fails closed when an armed bucket snapshot file is missing', async function(){
        let missing = path.join(os.tmpdir(), 'xchain-airdrop-unit-missing.csv');
        let { genesis } = build({ paths: [missing], hashes: [''], amounts: ['10'] });
        await assert.rejects(() => genesis.inject(100, 1700000000), /airdrop snapshot missing/);
    });

    it('fails closed on an all-zero snapshot (no positive quantities)', async function(){
        let file = tmpFile('address,quantity\naddr1,junk\n');
        let { genesis } = build({ paths: [file], hashes: [''], amounts: ['10'] });
        await assert.rejects(() => genesis.inject(100, 1700000000), /no positive holder quantities/);
    });

    it('credits buckets in canonical name order regardless of configured path order ', async function(){
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-order-'));
        let xdp = path.join(dir, 'xdp.csv'); fs.writeFileSync(xdp, 'daddr1,1\n');
        let xcp = path.join(dir, 'xcp.csv'); fs.writeFileSync(xcp, 'addr1,1\n');
        // Env lists XDP first; consensus order must still be XCP (name byte-order) first.
        let { genesis, calls } = build({ paths: [xdp, xcp], hashes: [sha256(xdp), sha256(xcp)], amounts: ['70', '30'] });
        await genesis.inject(100, 1700000000);
        let c = credits(calls);
        assert.deepStrictEqual(
            c.map(x => x.tx.data),
            ['ISSUE|2|XCHAIN||30.00000000|addr1',   // XCP bucket, amount stays zipped to its path
             'ISSUE|2|XCHAIN||70.00000000|daddr1']); // XDP bucket
    });

    it('fails closed on mainnet when any airdrop bucket lacks a sha256 pin ', async function(){
        let file = tmpFile('addr1,1\n');
        for(let hashes of [[], [''], ['not-a-hash']]){
            let { genesis, calls } = build({ paths: [file], hashes, amounts: ['10'] }, { NETWORK: 'mainnet' });
            await assert.rejects(() => genesis.inject(100, 1700000000), /mainnet airdrop bucket .* has no sha256 pin/);
            assert.strictEqual(credits(calls).length, 0);
        }
    });

    it('accepts a fully-pinned bucket set on mainnet', async function(){
        let file = tmpFile('addr1,1\n');
        let airdrop = { paths: [file], hashes: [sha256(file)], amounts: ['10'] };
        let { genesis, calls } = build(airdrop, { NETWORK: 'mainnet', GENESIS_AIRDROP_SET_HASH: setHash(airdrop) });
        await genesis.inject(100, 1700000000);
        assert.strictEqual(credits(calls).length, 1);
    });

    // ── Combined set-hash pin ( / ) ─────────────────────────────
    // The per-bucket hashes pin each snapshot FILE. Nothing pinned the SET: which
    // buckets exist, what each is funded with, and therefore which synthetic tx
    // hashes and XCHAIN amounts a replay derives. The set-hash was computed, logged
    // and then discarded; these tests hold it as an enforced pin.

    it('halts on a set-hash mismatch BEFORE any credit is injected', async function(){
        let file = tmpFile('addr1,1\naddr2,1\n');
        let airdrop = { paths: [file], hashes: [sha256(file)], amounts: ['10'] };
        let { genesis, calls } = build(airdrop, { GENESIS_AIRDROP_SET_HASH: 'a'.repeat(64) });
        await assert.rejects(() => genesis.inject(100, 1700000000), /airdrop set-hash mismatch/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('accepts a matching set-hash pin, case-insensitively', async function(){
        let file = tmpFile('addr1,1\n');
        let airdrop = { paths: [file], hashes: [sha256(file)], amounts: ['10'] };
        let { genesis, calls } = build(airdrop, { GENESIS_AIRDROP_SET_HASH: setHash(airdrop).toUpperCase() });
        await genesis.inject(100, 1700000000);
        assert.strictEqual(credits(calls).length, 1);
    });

    it('catches a re-funded bucket whose snapshot bytes are unchanged (the amount was pinned nowhere)', async function(){
        // Same CSV, same per-file pin, different XCHAIN amount: every pre- check
        // passes and the two nodes mint different allocations.
        let file    = tmpFile('addr1,1\n');
        let armed   = { paths: [file], hashes: [sha256(file)], amounts: ['30000000.00000000'] };
        let drifted = { paths: [file], hashes: [sha256(file)], amounts: ['40000000.00000000'] };
        let { genesis, calls } = build(drifted, { GENESIS_AIRDROP_SET_HASH: setHash(armed) });
        await assert.rejects(() => genesis.inject(100, 1700000000), /airdrop set-hash mismatch/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('catches a dropped bucket (set membership decides the synthetic tx hashes)', async function(){
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-set-'));
        let xcp = path.join(dir, 'xcp.csv'); fs.writeFileSync(xcp, 'addr1,1\n');
        let xdp = path.join(dir, 'xdp.csv'); fs.writeFileSync(xdp, 'daddr1,1\n');
        let armed   = { paths: [xcp, xdp], hashes: [sha256(xcp), sha256(xdp)], amounts: ['20', '10'] };
        let dropped = { paths: [xcp],      hashes: [sha256(xcp)],              amounts: ['20'] };
        let { genesis, calls } = build(dropped, { GENESIS_AIRDROP_SET_HASH: setHash(armed) });
        await assert.rejects(() => genesis.inject(100, 1700000000), /airdrop set-hash mismatch/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('halts when a set-hash is pinned but no buckets are armed (the disarmed half of the same fork)', async function(){
        let { genesis, calls } = build(null, { GENESIS_AIRDROP_SET_HASH: 'b'.repeat(64) });
        await assert.rejects(() => genesis.inject(100, 1700000000),
            /set-hash is pinned .* but no airdrop buckets are configured/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('fails closed on mainnet when the bucket set carries no set-hash pin', async function(){
        let file = tmpFile('addr1,1\n');
        let { genesis, calls } = build({ paths: [file], hashes: [sha256(file)], amounts: ['10'] }, { NETWORK: 'mainnet' });
        await assert.rejects(() => genesis.inject(100, 1700000000), /mainnet airdrop set is not pinned/);
        assert.strictEqual(credits(calls).length, 0);
    });

    it('leaves an unarmed, unpinned mainnet genesis alone (the airdrop stays disabled)', async function(){
        let { genesis, calls } = build(null, { NETWORK: 'mainnet' });
        await genesis.inject(100, 1700000000);
        assert.strictEqual(credits(calls).length, 0);
        assert.ok(calls.length > 0, 'name/gas-token injection still ran');
    });

    it('rejects two buckets sharing a basename (tx-hash namespace collision)', async function(){
        let dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-a-'));
        let dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-b-'));
        let a = path.join(dirA, 'xcp.csv'); fs.writeFileSync(a, 'addr1,1\n');
        let b = path.join(dirB, 'xcp.csv'); fs.writeFileSync(b, 'addr2,1\n');
        let { genesis } = build({ paths: [a, b], hashes: ['', ''], amounts: ['1', '1'] });
        await assert.rejects(() => genesis.inject(100, 1700000000), /duplicate airdrop bucket name/);
    });
});
