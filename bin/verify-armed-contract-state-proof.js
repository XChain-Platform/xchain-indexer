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
 * End-to-end contract-state proof against an ARMED chain's real committed data
 * (SPV sub-tree spec §3 Stage A items 4-5, ).
 *
 * WHAT THIS PROVES, and it is the last link the unit suites cannot close: that
 * the explorer's proof server, running over a REAL armed chain's
 * state_tree_roots + state_tree_nodes, produces a proof that the SDK's
 * independent client verifier accepts. Everything upstream of this has been
 * checked against stubs or against the indexer's own code; here the committed
 * bytes come from blocks a live chain actually produced, and the verifier is a
 * different implementation in a different repo.
 *
 * WHAT IT DOES NOT PROVE, stated so the result is not oversold: the quorum
 * layer. A production proof binds to a checkpoint whose state_root is
 * quorum-signed, and this harness feeds the chain's OWN committed state_root as
 * the trusted root instead, because the regtest venue has no signed checkpoints.
 * So this validates the proof MATH and the two implementations agreeing about
 * it, not the signature path (checkpoint.verifyCheckpoint covers that
 * separately). The trusted root is read from the same row the proof is built
 * over, which is exactly the binding _bindRoots enforces in production.
 *
 * READ-ONLY. It opens one connection, reads, and writes nothing.
 *
 * USAGE (on a host that runs the indexer, service env loaded)
 *   node bin/verify-armed-contract-state-proof.js --db XChain_BTC_Regtest_Indexer \
 *        --chain BTC --network regtest --height 10000
 *
 * It loads the explorer's proofServer.js and the SDK's light.js from the sibling
 * repos, so the proof is built and verified by the REAL modules rather than
 * copies. On a container without the siblings on disk, copy those files (and
 * their transitive requires) into one directory and pass --modules <dir>.
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
            default: console.error('unknown arg: ' + argv[i]); process.exit(64);
        }
    }
    if(!out.db || out.height == null){ console.error('--db and --height are required'); process.exit(64); }
    return out;
}

(async () => {
    const opts = parseArgs(process.argv);
    // Resolve the explorer's proof server and the SDK's verifier from the
    // sibling repos (the normal monorepo layout). `--modules <dir>` overrides
    // it for a staged container, where the siblings are not on disk and the
    // files are copied into one flat directory instead.
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

    const tr = (await q(
        'SELECT block_index, balances_root, stakes_root, state_root, block_merkle_root, contract_state_root ' +
        'FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
        [opts.chain, opts.network, opts.height]))[0];
    if(!tr){ console.error('no state_tree_roots row at ' + opts.height); process.exit(1); }
    if(!tr.contract_state_root){
        console.error('block ' + opts.height + ' committed NO contract_state_root; pick an armed height');
        process.exit(1);
    }
    console.log('# chain ' + opts.chain + '/' + opts.network + ' @ ' + opts.height +
                '  armed=' + SUB.isSubtreeActive('contract_state_root', opts.height, opts.network, opts.chain) +
                '  version=' + SUB.stateRootVersion(opts.height, opts.network, opts.chain));
    console.log('# committed contract_state_root: ' + tr.contract_state_root);

    // A real live contract-state key from this chain, chosen as-of the height.
    const row = (await q(
        'SELECT cs.contract_index, cs.state_key_bin AS state_key FROM contract_state cs ' +
        'INNER JOIN (SELECT MAX(id) AS id FROM contract_state WHERE block_index <= ? ' +
        '            GROUP BY contract_index, state_key_bin) l ON cs.id = l.id ' +
        'WHERE cs.state_value IS NOT NULL LIMIT 1', [opts.height]))[0];
    if(!row){ console.error('no live contract-state key at or below ' + opts.height); process.exit(1); }
    console.log('# proving contract ' + row.contract_index + ' key "' + row.state_key + '"');

    // The proof server, over a db adapter that speaks only what it needs. The
    // "checkpoint" carries the chain's OWN committed roots (see header).
    const server = new ProofServer({
        async getCheckpointAtOrAbove(){
            return { chain: opts.chain, network: opts.network, block_index: tr.block_index,
                     block_hash: '00'.repeat(32), ledger_hash: '00'.repeat(32),
                     actions_hash: '00'.repeat(32), contract_hash: '00'.repeat(32),
                     checkpoint_seq: 0, snapshot_block: tr.block_index,
                     state_root: tr.state_root,
                     state_root_version: SUB.stateRootVersion(opts.height, opts.network, opts.chain),
                     block_merkle_root: tr.block_merkle_root, block_merkle_version: 1,
                     validator_signatures: '[]' };
        },
        async getStateTreeRow(){ return tr; },
        async getStateNode(cfg, hash){
            const r = await q('SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash=? LIMIT 1', [String(hash)]);
            return (r && r.length) ? r[0] : null;
        },
        async getContractStateValueAtHeight(cfg, ci, key, h){
            const r = await q(
                'SELECT state_value FROM contract_state WHERE contract_index=? AND state_key_bin=? AND block_index<=? ' +
                'ORDER BY id DESC LIMIT 1', [Number(ci), String(key), Number(h)]);
            if(!r || !r.length) return null;
            return (r[0].state_value == null) ? null : String(r[0].state_value);
        },
        async getMaxBlockIndex(){ return (await q('SELECT MAX(block_index) t FROM blocks'))[0].t; }
    });

    const res = await server.contractStateProof({ coin: opts.chain }, opts.chain, opts.network,
                                                row.contract_index, row.state_key, opts.height);
    if(res.error){ console.error('# proof server refused: ' + res.error); await conn.end(); process.exit(1); }
    const p = res.proof;
    console.log('# served: leaf=' + (p.smt_proof.leaf_value ? String(p.smt_proof.leaf_value).slice(0, 20) + '..' : 'null') +
                '  value=' + JSON.stringify(p.state_value) + '  siblings=' + p.smt_proof.compressed.siblings.length);

    // THE CHECK: an independent implementation, in another repo, must accept it.
    const v = light.verifyContractStateProof(p, tr.state_root, opts.chain, opts.network);
    console.log('# SDK verifyContractStateProof -> verified=' + v.verified + ' reason=' + v.reason);
    console.log('# returned state_value matches the stored row: ' + (v.state_value === p.state_value));

    // And a NEGATIVE: tamper the value, the same verifier must reject it.
    const bad = Object.assign({}, p, { state_value: '"tampered"' });
    const bv = light.verifyContractStateProof(bad, tr.state_root, opts.chain, opts.network);
    console.log('# tampered value -> verified=' + bv.verified + ' reason=' + bv.reason);

    // And an absent key at the same armed height must be a verifiable NON-inclusion.
    const absent = await server.contractStateProof({ coin: opts.chain }, opts.chain, opts.network,
                                                   row.contract_index, 'definitely-not-a-real-key', opts.height);
    if(!absent.error){
        const av = light.verifyContractStateProof(absent.proof, tr.state_root, opts.chain, opts.network);
        console.log('# absent key -> verified=' + av.verified + ' value=' + JSON.stringify(av.state_value));
    }

    await conn.end();
    const ok = v.verified === true && bv.verified === false;
    console.log(ok ? '# RESULT: PASS' : '# RESULT: FAIL');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
