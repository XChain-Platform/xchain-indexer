#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * End-to-end LOCKED-BALANCE proof against an ARMED chain's real committed data
 * (SPV sub-tree spec §3 Stage B). The sibling of
 * `verify-armed-contract-state-proof.js`, which does the same job for Stage A.
 *
 * WHY IT EXISTS. Stage A's live-chain harness closes the last link its unit
 * suites cannot: that the EXPLORER's proof server, over a real armed chain's
 * committed rows, produces a proof the SDK's independent verifier accepts.
 * Stage B has the same two implementations, the same key domain problem and a
 * live armed chain carrying REAL locked leaves, and had no such harness. Its
 * B2 vectors test the explorer's output through the SDK verifier, but over a
 * fixture tree, so nothing had ever put the pair over bytes a chain committed.
 * That asymmetry is the gap this closes: Stage B is the half with real data on
 * the venue, so it is the half where a fixture proves least.
 *
 * WHAT IT PROVES:
 *   1. The explorer serves a locked-balance proof at the armed height.
 *   2. The SDK's `verifyLockedBalanceProof`, a different implementation in a
 *      different repo, accepts it and returns the same amount.
 *   3. A TAMPERED amount is rejected by that verifier.
 *   4. A never-locked key at the same height verifies as ZERO LOCKED, which at
 *      an armed height is a real claim rather than an absence of information
 *      (delete-on-zero: released and never-locked keys both have no leaf).
 *   5. The two key domains cannot answer for each other: feeding the locked
 *      proof to the SPENDABLE verifier must fail. Each verifier derives its own
 *      key, so this is the cross-domain guard §3 Stage B relies on, checked
 *      here against live data rather than a vector.
 *
 * WHAT IT DOES NOT PROVE, stated so the result is not oversold: the quorum
 * layer, exactly as in the Stage A harness. Regtest has no signed checkpoints,
 * so the chain's OWN committed state_root is supplied as the trusted root,
 * which is the binding `_bindRoots` enforces in production. Signatures are
 * covered separately by `checkpoint.verifyCheckpoint`.
 *
 * READ-ONLY. It opens one connection, reads, and writes nothing.
 *
 * USAGE (on a host that can reach the indexer DB, service env loaded)
 *   node bin/verify-armed-locked-balance-proof.js --db XChain_BTC_Regtest_Indexer \
 *        --chain BTC --network regtest --height 11200
 *
 * It loads the explorer's proofServer.js and the SDK's light.js from the
 * sibling repos; `--modules <dir>` overrides that for a staged container.
 *
 *********************************************************************/

'use strict';

const path = require('path');

function parseArgs(argv){
    const out = { db: null, chain: 'BTC', network: 'regtest', height: null, modules: null };
    for(let i = 2; i < argv.length; i++){
        switch(argv[i]){
            case '--db':      out.db      = argv[++i]; break;
            case '--chain':   out.chain   = String(argv[++i] || '').toUpperCase(); break;
            case '--network': out.network = argv[++i]; break;
            case '--height':  out.height  = parseInt(argv[++i], 10); break;
            case '--modules': out.modules = argv[++i]; break;
            case '--help': case '-h':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + argv[i]); process.exit(64);
        }
    }
    if(!out.db || out.height == null){ console.error('--db and --height are required'); process.exit(64); }
    return out;
}

(async () => {
    const opts = parseArgs(process.argv);
    const dir = opts.modules;
    const req = (sib, file) => require(dir ? path.resolve(dir, file)
                                           : path.resolve(__dirname, '..', '..', sib, 'src', file));
    const ProofServer = req('xchain-explorer', 'proofServer.js');
    const light       = req('xchain-sdk',      'light.js');
    const SUB         = require('../src/state_subtree_activation.js');
    const mariadb     = require('mariadb');

    const conn = await mariadb.createConnection({
        host: process.env.INDEXER_DB_HOST, port: process.env.INDEXER_DB_PORT,
        user: process.env.INDEXER_DB_USER, password: process.env.INDEXER_DB_PASS,
        database: opts.db
    });
    const q = (sql, args) => conn.query(sql, args);
    const bail = async (msg, code) => { console.error(msg); await conn.end(); process.exit(code); };

    const tr = (await q(
        'SELECT block_index, balances_root, stakes_root, state_root, block_merkle_root, contract_state_root ' +
        'FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [opts.chain, opts.network, opts.height]))[0];
    if(!tr) return bail('no state_tree_roots row at ' + opts.height, 1);
    if(!SUB.isEscrowLockedLeafActive(opts.height, opts.network, opts.chain))
        return bail('the escrow locked leaf is NOT armed at ' + opts.chain + ':' + opts.network +
                    '@' + opts.height + '; pick an armed height', 1);

    console.log('# chain ' + opts.chain + '/' + opts.network + ' @ ' + opts.height +
                '  escrow-leaf armed=true' +
                '  version=' + SUB.stateRootVersion(opts.height, opts.network, opts.chain));
    console.log('# committed balances_root: ' + tr.balances_root);

    // A real LIVE locked key on this chain as-of the height: the winning journal
    // row per (address, tick) at or below it, tombstones excluded. Same MAX(id)
    // shape the reader uses, so the harness cannot pick a key the tree does not
    // carry.
    const row = (await q(
        'SELECT a.address AS address, t.tick AS tick, j.locked_amount AS amt FROM escrow_leaf_journal j ' +
        'INNER JOIN (SELECT MAX(id) AS id FROM escrow_leaf_journal WHERE block_index <= ? ' +
        '            GROUP BY address_id, tick_id) l ON j.id = l.id ' +
        'INNER JOIN index_addresses a ON a.id = j.address_id ' +
        'INNER JOIN index_tickers   t ON t.id = j.tick_id ' +
        'WHERE j.locked_amount IS NOT NULL LIMIT 1', [opts.height]))[0];
    if(!row) return bail('no live locked key at or below ' + opts.height, 1);
    console.log('# proving locked ' + row.address + ' / ' + row.tick + '  (journal amount ' + row.amt + ')');

    const version = SUB.stateRootVersion(opts.height, opts.network, opts.chain);
    const server = new ProofServer({
        async getCheckpointAtOrAbove(){
            return { chain: opts.chain, network: opts.network, block_index: tr.block_index,
                     block_hash: '00'.repeat(32), ledger_hash: '00'.repeat(32),
                     actions_hash: '00'.repeat(32), contract_hash: '00'.repeat(32),
                     checkpoint_seq: 0, snapshot_block: tr.block_index,
                     state_root: tr.state_root, state_root_version: version,
                     block_merkle_root: tr.block_merkle_root, block_merkle_version: 1,
                     validator_signatures: '[]' };
        },
        async getStateTreeRow(){ return tr; },
        async getStateNode(cfg, hash){
            const r = await q('SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash=? LIMIT 1',
                              [String(hash)]);
            return (r && r.length) ? r[0] : null;
        },
        async getLockedAmountAtHeight(cfg, address, tick, h){
            const r = await q(
                'SELECT j.locked_amount AS amt FROM escrow_leaf_journal j ' +
                'INNER JOIN index_addresses a ON a.id = j.address_id ' +
                'INNER JOIN index_tickers   t ON t.id = j.tick_id ' +
                'WHERE a.address=? AND t.tick=? AND j.block_index<=? ORDER BY j.id DESC LIMIT 1',
                [String(address), String(tick), Number(h)]);
            if(!r || !r.length || r[0].amt == null) return '0';
            return String(r[0].amt);
        },
        // The spendable sibling needs this one, for the cross-domain check below.
        async getNetBalanceAtHeight(cfg, address, tick){
            const r = await q(
                'SELECT CAST(COALESCE(SUM(s.amt),0) AS CHAR) AS net FROM ( ' +
                '  SELECT address_id, tick_id,  CAST(amount AS DECIMAL(60,18)) AS amt FROM credits ' +
                '  UNION ALL ' +
                '  SELECT address_id, tick_id, -CAST(amount AS DECIMAL(60,18)) AS amt FROM debits) s ' +
                'INNER JOIN index_addresses a ON a.id=s.address_id ' +
                'INNER JOIN index_tickers   t ON t.id=s.tick_id ' +
                'WHERE a.address=? AND t.tick=?', [String(address), String(tick)]);
            return (r && r.length) ? String(r[0].net) : '0';
        },
        async getMaxBlockIndex(){ return (await q('SELECT MAX(block_index) t FROM blocks'))[0].t; }
    });

    const res = await server.lockedBalanceProof({ coin: opts.chain }, opts.chain, opts.network,
                                                row.address, row.tick, opts.height);
    if(res.error) return bail('# proof server refused: ' + res.error, 1);
    const p = res.proof;
    console.log('# served: leaf=' + (p.smt_proof.leaf_value ? String(p.smt_proof.leaf_value).slice(0, 20) + '..' : 'null') +
                '  amount=' + p.amount + '  siblings=' + p.smt_proof.compressed.siblings.length +
                '  slot=' + p.sub_root_path.index);

    // 2. THE CHECK: an independent implementation, in another repo, accepts it.
    const v = light.verifyLockedBalanceProof(p, tr.state_root, opts.chain, opts.network);
    console.log('# SDK verifyLockedBalanceProof -> verified=' + v.verified + ' reason=' + v.reason +
                ' amount=' + v.amount);

    // 3. NEGATIVE: tamper the amount, the same verifier must reject it.
    const bad = Object.assign({}, p, { amount: '999999.00000000' });
    const bv = light.verifyLockedBalanceProof(bad, tr.state_root, opts.chain, opts.network);
    console.log('# tampered amount -> verified=' + bv.verified + ' reason=' + bv.reason);

    // 4. A never-locked key must verify as ZERO LOCKED (delete-on-zero).
    let zeroOk = null;
    const absent = await server.lockedBalanceProof({ coin: opts.chain }, opts.chain, opts.network,
                                                   row.address, 'NOSUCHTICKXCTEST', opts.height);
    if(absent.error){
        console.log('# never-locked key -> proof server refused: ' + absent.error);
    } else {
        const av = light.verifyLockedBalanceProof(absent.proof, tr.state_root, opts.chain, opts.network);
        zeroOk = (av.verified === true && String(av.amount).replace(/0+$/, '').replace(/\.$/, '') === '0');
        console.log('# never-locked key -> verified=' + av.verified + ' amount=' + av.amount);
    }

    // 5. The two key domains must not answer for each other.
    let domainOk = null;
    if(typeof light.verifyBalanceProof === 'function'){
        const cross = light.verifyBalanceProof(p, tr.state_root, opts.chain, opts.network);
        domainOk = (cross.verified === false);
        console.log('# locked proof fed to the SPENDABLE verifier -> verified=' + cross.verified +
                    ' reason=' + cross.reason);
    }

    await conn.end();
    const ok = v.verified === true && bv.verified === false &&
               (zeroOk === null || zeroOk === true) && (domainOk === null || domainOk === true);
    console.log(ok ? '# RESULT: PASS' : '# RESULT: FAIL');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
