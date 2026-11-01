#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * Records an operator authorization for one retroactive replay target.
 *
 ********************************************************************/

'use strict';

const {
    parseGoArgs,
    parseRewitnessArgs,
} = require('../src/consensus/retroactive/go_binding.js');
const { recordRetroactiveGo } = require('../src/db/events/retroactive_go.js');
const {
    readLatestReplayWitness,
    recordReplayWitnessPhase,
} = require('../src/db/events/retroactive_replay_witness.js');

async function recordGo(argv, db){
    const request = parseGoArgs(argv);
    await recordRetroactiveGo(db, request);
    return request;
}

function openIndexerDb(){
    require('dotenv').config();
    const config = require('../src/config.js');
    const Database = require('../src/db');
    const Utility = require('../src/utility.js');
    const env = config.CONFIG_ENV;
    if(!env.INDEXER_DB_HOST || !env.INDEXER_DB_NAME || !env.INDEXER_DB_USER)
        throw new Error('INDEXER_DB_HOST / INDEXER_DB_NAME / INDEXER_DB_USER must be set');

    const cfg = config.getConfig();
    const parent = { config: cfg, util: new Utility(cfg) };
    const db = new Database(env.INDEXER_DB_HOST, env.INDEXER_DB_PORT,
        env.INDEXER_DB_NAME, env.INDEXER_DB_USER, env.INDEXER_DB_PASS, parent);
    parent.indexerDb = db;
    return db;
}

async function main(argv, deps = {}){
    const rewitness = Array.isArray(argv) && argv.includes('--rewitness');
    const rewitnessRequest = rewitness && argv.length > 1 ? parseRewitnessArgs(argv) : null;
    const request = rewitness ? null : parseGoArgs(argv);
    const ownsDb = !deps.db;
    const db = deps.db || openIndexerDb();
    const write = deps.write || (text => process.stdout.write(text));
    try {
        if(rewitness){
            const witness = await readLatestReplayWitness(db);
            if(!witness) throw new Error('no replay witness to restart');
            if(rewitnessRequest && rewitnessRequest.target !== witness.phase.target)
                throw new Error('rewitness target ' + rewitnessRequest.target +
                    ' does not match open replay target ' + witness.phase.target);
            const phase = {
                phase: 'witness',
                target: witness.phase.target,
                replay_to: witness.phase.replay_to,
                rules_from: witness.phase.rules_from,
                window_count: witness.phase.window_count,
                map_count: witness.phase.map_count,
            };
            await recordReplayWitnessPhase(db, witness.batch, phase);
            write('retroactive-go: recorded rewitness for target ' + phase.target + '\n');
            return phase;
        }
        await recordRetroactiveGo(db, request);
        write('retroactive-go: recorded target ' + request.target +
            ' with rules ' + request.rules + '\n');
        return request;
    } finally {
        if(ownsDb && db.close) await db.close();
    }
}

if(require.main === module){
    main(process.argv.slice(2)).catch(err => {
        process.stderr.write('retroactive-go: ' + ((err && err.message) || err) + '\n');
        process.exitCode = 2;
    });
}

module.exports = { recordGo, openIndexerDb, main };
