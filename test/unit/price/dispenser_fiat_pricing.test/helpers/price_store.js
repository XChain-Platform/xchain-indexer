/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * A price mirror the FIAT settlement reads run against for real: node:sqlite in
 * memory, with price_snapshots and oracle_prices built from the project's own
 * src/sql DDL, and the db/prices mixin installed on top so every read issues the
 * statement the indexer issues. Two stores filled with the same rows in a
 * different order stand in for two nodes whose mirrors received them in a
 * different order. Also the arming lever for dispenser_fiat_pricing_activation.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const prices = require('../../../../../src/db/prices/index.js');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'sql');
const ARMING_ENV = 'XC_DISPENSER_FIAT_PRICING_REGTEST_ACTIVATION';

// The MariaDB DDL with comments, index lines and storage clauses removed, so sqlite
// builds the same columns with the same defaults.
function sqliteDdl(table){
    let text = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8')
        .split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
    return text
        .replace(/^\s*(UNIQUE\s+)?KEY\s.*$/gim, '')
        .replace(/,\s*\)\s*ENGINE=[^;]*;/, '\n);')
        .replace(/ENUM\([^)]*\)/gi, 'TEXT')
        .replace(/BIGINT\s+(NOT NULL\s+)?AUTO_INCREMENT\s+PRIMARY KEY/i, 'INTEGER PRIMARY KEY')
        .replace(/\bUNSIGNED\b/gi, '');
}

// A store for an indexer of `coin` on `network` (regtest by default), holding `rows`
// inserted in the order given. A row with `round` is a price_snapshots round, any other row
// an oracle_prices row.
function priceStore(coin, rows, network){
    const db = new DatabaseSync(':memory:');
    db.exec(sqliteDdl('price_snapshots'));
    db.exec(sqliteDdl('oracle_prices'));
    const insertRound = db.prepare(`INSERT INTO price_snapshots (round_number, coin_pair, price, reference_block,
        block_timestamp, validator_count, consensus_proof, status, admit_block_ltc, batch_block_time)
        VALUES (?, ?, ?, ?, ?, 3, '{}', 'finalized', ?, ?)`);
    const insertOracle = db.prepare(`INSERT INTO oracle_prices (source_address, source_chain, coin, tick, fiat, value,
        fee, block_time, effective_at, action_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows){
        if (r.round !== undefined)
            insertRound.run(r.round, r.pair, r.price, r.ref || 0, r.ts, r.admitLtc === undefined ? null : r.admitLtc, r.bbt || 0);
        else
            insertOracle.run(r.addr, r.chain, r.coin, r.tick, r.fiat, r.value, r.fee || '0', r.eff - 86400, r.eff, r.ai);
    }
    return Object.assign({}, prices, {
        config: { COIN: coin, NETWORK: network || 'regtest' },
        assertPriceBarrierNotSkipped(){},
        async doQueryStrict(query, args){ return db.prepare(query).all(...args); },
    });
}

// Run `fn` with the regtest arming lever set to `value` (undefined unsets it), then put
// the environment back as it was.
async function withArming(value, fn){
    const saved = process.env[ARMING_ENV];
    if (value === undefined) delete process.env[ARMING_ENV];
    else process.env[ARMING_ENV] = value;
    try { return await fn(); }
    finally {
        if (saved === undefined) delete process.env[ARMING_ENV];
        else process.env[ARMING_ENV] = saved;
    }
}

module.exports = { priceStore, withArming };
