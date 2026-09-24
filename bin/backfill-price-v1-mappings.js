#!/usr/bin/env node
'use strict';

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
 * Backfill tool for PRICE v1 SOURCE mappings (Issue #40).
 *
 * A PRICE v1 action indexed before 9fed3912 never staged its SOURCE through
 * addAddressTicker, so the oracle's own publish (rejected quotes included) never
 * reached mappings_actions and is invisible in that address's per-address history
 * on the explorer and in the wallet. This tool finds every stored PRICE v1 action,
 * valid or invalid, still missing that mapping row and re-runs the SAME
 * addAddressTicker + createMappings path 9fed3912 wired into the live parser, so a
 * backfilled row is indistinguishable from one the parser wrote at indexing time.
 *
 * Prints the planned rows by default; writes only with --apply. DB settings come
 * through the project config layer (src/config.js) and the service environment
 * (INDEXER_DB_*), the same way bin/recovery.js and bin/repair-balances-root.js read
 * them: never from the command line.
 *
 *   node bin/backfill-price-v1-mappings.js
 *   node bin/backfill-price-v1-mappings.js --apply
 *
 ********************************************************************/

// Run as a CLI, load .env before any local require (src/config.js captures the
// environment once at module load). Required as a module (the tests), the caller's
// environment is left alone; see bin/recovery.js for the same convention.
if(require.main === module) require('dotenv').config();

const priceV1MappingBackfill = require('../src/db/prices/price_v1_mapping_backfill.js');

// Finds every unmapped PRICE v1 SOURCE and prints the planned rows; with apply,
// replays addAddressTicker + createMappings for each one exactly as
// src/actions/price/index.js does at parse time. db/util/mapper are handed in
// rather than constructed here so the unit suite can drive this against a stubbed
// DB without touching any real database, local, regtest or live.
async function runBackfill(deps){
    let db      = deps.db;
    let util    = deps.util;
    let mapper  = deps.mapper;
    let apply   = !!deps.apply;

    let candidates = await priceV1MappingBackfill.findUnmappedPriceV1MappingSources.call(db);

    for(let row of candidates){
        console.log((apply ? 'BACKFILLING' : 'PLANNED') + ': action_index=' + row.actionIndex +
            ' source=' + row.sourceAddress);
    }

    if(apply){
        for(let row of candidates){
            // Same per-action reset the live block loop runs before every dispatch
            // (actions/actions_class/dispatch.js): addAddressTicker stages onto a
            // shared in-memory list, so a stale entry from a prior action_index in
            // this loop cannot bleed into this row's mapping write.
            util.resetLists();
            util.addAddressTicker(row.sourceAddress);
            // STATUS only changes createMappings' behavior for a LINK action; this
            // backfill only ever replays PRICE rows, so the value here is inert.
            await mapper.createMappings({ ACTION: 'PRICE', ACTION_INDEX: row.actionIndex, STATUS: 'valid' });
        }
    }

    console.log((apply ? 'Applied ' : 'Would apply ') + candidates.length + ' PRICE v1 SOURCE mapping(s).');
    return candidates;
}

module.exports = { runBackfill };

if(require.main === module){
    (async () => {
        const Database = require('../src/db');
        const config   = require('../src/config.js');
        const Utility  = require('../src/utility.js');
        const Mapper   = require('../src/chain/mapper.js');

        const apply = process.argv.includes('--apply');

        const host = process.env.INDEXER_DB_HOST;
        const port = process.env.INDEXER_DB_PORT;
        const name = process.env.INDEXER_DB_NAME;
        const user = process.env.INDEXER_DB_USER;
        const pass = process.env.INDEXER_DB_PASS;
        if(!host || !name || !user){
            console.error('backfill-price-v1-mappings: INDEXER_DB_HOST / INDEXER_DB_NAME / INDEXER_DB_USER must be set.');
            process.exit(2);
        }

        const cfg    = config.getConfig();
        const util   = new Utility(cfg);
        const db     = new Database(host, port, name, user, pass, { config: cfg, util: util });
        const mapper = new Mapper({ config: cfg, util: util, indexerDb: db, decoderDb: null });

        try {
            await runBackfill({ db: db, util: util, mapper: mapper, apply: apply });
            process.exitCode = 0;
        } catch(err){
            console.error('backfill-price-v1-mappings: FAILED: ' + ((err && err.stack) || err));
            process.exitCode = 1;
        } finally {
            process.exit();
        }
    })();
}
