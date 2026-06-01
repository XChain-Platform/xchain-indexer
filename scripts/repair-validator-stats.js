/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Indexer - attest_validator_stats repair tool
 *
 * Rebuilds every attest_validator_stats row from scratch by aggregating the
 * surviving ledger. attest_validator_stats is a monotone aggregate
 * (fulfilled/missed/slashed counters per validator/provider) that, before the
 * rollback fix landed, was not cleaned up on chain reorganization — so any node
 * that processed a reorg may carry permanently overcounted fulfilled/missed
 * counts. Run this ONCE against such a deployment to bring the table back in line
 * with a from-genesis replay.
 *
 * It is idempotent and safe to run on a healthy DB: the recomputed values equal
 * what a clean replay produces. Reads DB connection settings from the same
 * environment variables the indexer uses (INDEXER_DB_HOST/PORT/NAME/USER/PASS,
 * INDEXER_COIN, INDEXER_NETWORK) — run it from the indexer root with the same
 * .env in place.
 *
 * Usage:  node scripts/repair-validator-stats.js
 *
 ********************************************************************/

const crypto   = require('crypto');
const dotenv   = require('dotenv');
const path     = require('path');
const config   = require('../src/config.js');
const Database = require('../src/db.js');
const Utility  = require('../src/utility.js');

dotenv.config();

// Deterministic responsible validator set — mirrors attest.js
// _computeResponsibleSet: sort the capability validators by
// SHA256(request_id || pubkey), take the top REDUNDANCY.
function responsibleSet(requestId, validators, redundancy){
    if(!validators || validators.length === 0)
        return [];
    let withHash = validators.map(pk => ({
        pubkey: pk,
        hash:   crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex')
    }));
    withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
    return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
}

async function main(){
    let required = ['INDEXER_DB_HOST','INDEXER_DB_PORT','INDEXER_DB_NAME','INDEXER_DB_USER','INDEXER_DB_PASS'];
    for(let key of required){
        if(!process.env[key]){
            console.error('Missing required environment variable: ' + key);
            process.exit(1);
        }
    }

    // Build a minimal indexer-like parent (config + util) the way XChainIndexer
    // does, then open the indexer DB connection through the standard Database class.
    let parent  = {};
    parent.config = config.getConfig();
    parent.util   = new Utility();
    let db = new Database(
        process.env.INDEXER_DB_HOST,
        process.env.INDEXER_DB_PORT,
        process.env.INDEXER_DB_NAME,
        process.env.INDEXER_DB_USER,
        process.env.INDEXER_DB_PASS,
        parent
    );
    parent.indexerDb = db;

    console.log('Recomputing attest_validator_stats from surviving ledger data...');

    // key -> { pubkey, provider, fulfilled, missed, lastBlock }
    let stats  = new Map();
    let ensure = (pubkey, provider) => {
        let key = pubkey + '|' + provider;
        if(!stats.has(key))
            stats.set(key, { pubkey, provider, fulfilled: 0, missed: 0, lastBlock: 0 });
        return stats.get(key);
    };

    // fulfilled_count: one per verified signature contributed to a STATUS='ok'
    // response (attest.js _parseResponse). Signatures ride in the
    // validator_signatures JSON column on the v1 response rows, so we aggregate
    // them in JS rather than joining a child table.
    let okResponses = await db.doQuery(
        `SELECT provider_id, validator_signatures, block_index
         FROM attests
         WHERE version = 1 AND response_status = 'ok' AND validator_signatures IS NOT NULL`,
        []
    );
    for(let row of okResponses){
        let sigs = [];
        try { sigs = JSON.parse(row.validator_signatures) || []; }
        catch(_) { sigs = []; }
        let provider = String(row.provider_id);
        let block    = Number(row.block_index) || 0;
        for(let sig of sigs){
            if(!sig || !sig.pubkey) continue;
            let s = ensure(String(sig.pubkey).toLowerCase(), provider);
            s.fulfilled += 1;
            s.lastBlock = Math.max(s.lastBlock, block);
        }
    }

    // missed_count: one per responsible-set validator each time a request expired
    // (attest.js _parseExpire). There is no per-validator expiry row to count — we
    // reproduce the responsible set deterministically and bump each member, exactly
    // as the live path does. A request counts as expired iff (a) its expiry sweep
    // has actually happened — a request expires at deadline_block+1, so the sweep
    // occurred iff deadline_block+1 <= tip (i.e. deadline_block < tip), where tip is
    // the latest parsed block; a request still inside its deadline window is
    // 'pending' and has recorded zero misses — and (b) no *valid* v1 response
    // survives for it (any valid response flips it out of 'pending' before the
    // deadline). We derive eligibility from the surviving v0 rows, NOT
    // request_status, because a reorg-undone response/expiry leaves request_status
    // stale — the same staleness hazard a post-reorg repair must avoid. This mirrors
    // Rollback._recomputeAttestationValidatorStats with the rollback target replaced
    // by tip+1, so its cutoff `deadline_block < block_index-1` becomes
    // `deadline_block < tip` over the whole surviving chain.
    let tip     = await db.getLatestBlockIndex();
    let validId = await db.getStatusId('valid');
    let expiredReqs = await db.doQuery(
        `SELECT ar.request_id, ar.provider_id, ar.redundancy, ar.block_index, ar.deadline_block
         FROM attests ar
         WHERE ar.version = 0
           AND ar.deadline_block < ?
           AND NOT EXISTS (
               SELECT 1 FROM attests r
               WHERE r.version = 1
                 AND r.request_id = ar.request_id
                 AND r.status_id = ?
           )`,
        [tip, validId]
    );
    let validatorsByBlock = new Map();
    for(let req of expiredReqs){
        let reqBlock   = Number(req.block_index);
        let validators = validatorsByBlock.get(reqBlock);
        if(validators === undefined){
            let vs     = await db.getValidatorsByCapability('attestation', reqBlock);
            validators = (vs || []).map(v => String(v.pubkey).toLowerCase());
            validatorsByBlock.set(reqBlock, validators);
        }
        let responsible = responsibleSet(String(req.request_id), validators, Number(req.redundancy));
        let provider    = String(req.provider_id);
        let expiryBlock  = Number(req.deadline_block) + 1;
        for(let pubkey of responsible){
            let s = ensure(pubkey, provider);
            s.missed   += 1;
            s.lastBlock = Math.max(s.lastBlock, expiryBlock);
        }
    }

    // Atomically swap in the recomputed table. slashed_count/quality_score are
    // Phase 4 (no producer yet) and recompute to 0.
    let rows = [...stats.values()].filter(s => s.fulfilled > 0 || s.missed > 0);
    await db.beginTransaction();
    try {
        await db.doQuery('DELETE FROM attest_validator_stats', []);
        for(let s of rows){
            await db.doQuery(
                `INSERT INTO attest_validator_stats
                    (validator_pubkey, provider_id, fulfilled_count, missed_count, slashed_count, quality_score, last_updated_block)
                 VALUES (?, ?, ?, ?, 0, 0, ?)`,
                [s.pubkey, s.provider, s.fulfilled, s.missed, s.lastBlock]
            );
        }
        await db.commitTransaction();
    } catch(e){
        await db.rollbackTransaction();
        throw e;
    }

    let totalFulfilled = rows.reduce((a, s) => a + s.fulfilled, 0);
    let totalMissed    = rows.reduce((a, s) => a + s.missed, 0);
    console.log('Recompute complete:');
    console.log('  ' + rows.length + ' (validator, provider) rows written');
    console.log('  ' + totalFulfilled + ' total fulfilled_count');
    console.log('  ' + totalMissed + ' total missed_count');
    console.log('  ' + expiredReqs.length + ' expired requests scanned for misses');

    await db.releaseConnection();
    if(db.pool) await db.pool.end();
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('repair-validator-stats failed:', err && err.message ? err.message : err);
    process.exit(1);
});
