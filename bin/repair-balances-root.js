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
 * Repair a chain whose committed `balances_root` has drifted BELOW a full
 * rebuild of its own ledger .
 *
 * WHY THIS EXISTS. `db._smtTickName` used to cache an ABSENT ticker name, and a
 * cached absence made `createLedgerChangeRecord` skip every later touch for that
 * tick for the connection's lifetime, so the tick's balance leaves were never
 * committed. The cause is fixed (indexer 2db73fa) but a fix does not un-drop the
 * leaves: a chain that ran the old code carries a `balances_root` that is
 * internally consistent, agreed by every peer running the same code, and
 * incomplete. Nothing detects it until some node takes a full-rebuild path (a
 * follower's seedSnapshotRoots, a flag-day arming block) and computes the
 * complete tree, at which point it diverges from the chain it is following.
 *
 * WHAT IT DOES, and the scope is deliberately narrow: it recomputes
 * `balances_root` at ONE height through the REAL `stateCommitment` derivation
 * (so the repaired value is by construction the value a from-genesis node would
 * compute), reassembles `state_root` from that plus the row's OWN stored
 * `stakes_root` and reserved sub-roots, and updates that single row.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: rewrite history. Rows below the repair
 * height keep the roots the chain actually committed, because that is the
 * faithful record of what was signed and served. The repair is forward-looking:
 * the next block threads from the repaired root, so from the repair height on,
 * the chain and a full rebuild agree. Proofs served for heights BELOW the repair
 * still verify against their own committed roots; they are simply missing the
 * affected keys, which is what the chain committed at the time.
 *
 * SAFETY. Dry run by default. Refuses mainnet outright unless --allow-mainnet is
 * passed as well as --apply, because on mainnet this rewrites a value validators
 * have signed over and that is an operator decision, not a script's. Refuses if
 * the chain moves underneath it (the tip is re-read after the rebuild and must
 * match), and refuses when there is nothing to repair.
 *
 * Credentials come from the service environment exactly as the benches read
 * them: never from the command line, never printed.
 *
 *   node bin/repair-balances-root.js --db <name> --chain BTC --network regtest
 *   node bin/repair-balances-root.js --db <name> --chain BTC --network regtest --apply
 *
 ********************************************************************/

'use strict';

const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const M   = require(path.join(SRC, 'merkle.js'));
const SC  = require(path.join(SRC, 'stateCommitment.js'));
const SUB = require(path.join(SRC, 'state_subtree_activation.js'));

function parseArgs(){
    const a = process.argv.slice(2), o = { apply: false, allowMainnet: false, block: null };
    for(let i = 0; i < a.length; i++){
        switch(a[i]){
            case '--db':            o.db = a[++i]; break;
            case '--chain':         o.chain = a[++i]; break;
            case '--network':       o.network = a[++i]; break;
            case '--block':         o.block = Number(a[++i]); break;
            case '--apply':         o.apply = true; break;
            case '--allow-mainnet': o.allowMainnet = true; break;
            case '--help': case '-h':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + a[i]); process.exit(64);
        }
    }
    if(!o.chain || !o.network){ console.error('--chain and --network are required'); process.exit(64); }
    return o;
}

(async () => {
    const opts = parseArgs();

    const Database = require(path.join(SRC, 'db.js'));
    const config   = require(path.join(SRC, 'config.js'));
    const Utility  = require(path.join(SRC, 'utility.js'));
    const cfg  = config.getConfig(opts.chain, opts.network);
    const util = new Utility(cfg);
    const db   = new Database(process.env.INDEXER_DB_HOST, process.env.INDEXER_DB_PORT,
                              opts.db || process.env.INDEXER_DB_NAME,
                              process.env.INDEXER_DB_USER, process.env.INDEXER_DB_PASS,
                              { config: cfg, util: util });

    if(opts.network === 'mainnet' && opts.apply && !opts.allowMainnet){
        console.error('refusing: --apply on mainnet rewrites a root validators have signed over.');
        console.error('That is an operator decision. Re-run with --allow-mainnet if it really is one.');
        process.exit(3);
    }

    async function tipRow(){
        const rows = await db.doQueryStrict(
            'SELECT block_index, balances_root, stakes_root, state_root, block_merkle_root, contract_state_root ' +
            'FROM state_tree_roots WHERE chain=? AND network=? ' +
            (opts.block == null ? 'ORDER BY block_index DESC LIMIT 1' : 'AND block_index=? LIMIT 1'),
            opts.block == null ? [opts.chain, opts.network] : [opts.chain, opts.network, opts.block]);
        return rows.length ? rows[0] : null;
    }

    const before = await tipRow();
    if(!before){
        console.error('no state_tree_roots row for ' + opts.chain + '/' + opts.network +
                      (opts.block == null ? ' (state commitment never armed here?)' : ' at block ' + opts.block));
        process.exit(2);
    }
    const height = Number(before.block_index);
    console.log('# chain ' + opts.chain + '/' + opts.network + '  repair height ' + height);
    console.log('# committed balances_root ' + before.balances_root);

    // The real derivation. buildFullBalancesRoot persists SMT nodes through
    // DbNodeStore, which is exactly what we want: the repaired root must be
    // walkable by the proof server, so its internal nodes have to exist.
    // state_tree_nodes is copy-on-write and rollback-exempt, so writing the
    // nodes is additive and safe even if the update below is not applied.
    const t0 = Date.now();
    const rebuilt = await SC.buildFullBalancesRoot(db, opts.chain, opts.network, height);
    console.log('# rebuilt   balances_root ' + rebuilt + '   (' + (Date.now() - t0) + ' ms)');

    if(rebuilt === before.balances_root){
        console.log('# NOTHING TO REPAIR: the committed root already equals a full rebuild.');
        if(db.close) await db.close();
        process.exit(0);
    }

    // Reassemble state_root from the repaired balances_root plus this row's OWN
    // stored stakes_root and reserved sub-roots, so a chain with an armed slot
    // (Stage A) keeps that slot bound at its real position. Deriving the extras
    // from the STORED column rather than re-running the gate is the same choice
    // the explorer makes: the row already carries the arming decision for its own
    // height, and a second copy of the activation map could only drift from it.
    const extras = (before.contract_state_root == null) ? null
                 : { contract_state_root: String(before.contract_state_root) };
    const stateRoot = SC.assembleStateRoot(rebuilt, before.stakes_root, extras);
    console.log('# committed state_root    ' + before.state_root);
    console.log('# rebuilt   state_root    ' + stateRoot);
    console.log('# reserved slots carried  ' + (extras ? Object.keys(extras).join(', ') : '(none: v1 assembly)'));
    console.log('# state_root_version at this height: ' +
                SUB.stateRootVersion(height, opts.network, opts.chain));

    // Sanity: the repaired state_root must reassemble from its parts, or the row
    // would serve PROOF_STATE_ROOT_MISMATCH for every proof at this height.
    const check = SC.assembleStateRoot(rebuilt, before.stakes_root, extras);
    if(check !== stateRoot){
        console.error('refusing: state_root is not reproducible from its own parts');
        process.exit(4);
    }

    if(!opts.apply){
        console.log('#');
        console.log('# DRY RUN: nothing was written to state_tree_roots.');
        console.log('# (SMT nodes for the rebuilt tree WERE persisted; that is additive and');
        console.log('#  copy-on-write, and it is what makes the repaired root provable.)');
        console.log('# Re-run with --apply to update block ' + height + '.');
        if(db.close) await db.close();
        process.exit(0);
    }

    // The chain must not have moved: a repaired root written to a height that is
    // no longer the tip would be threaded from by a block that already threaded
    // from the old value, which forks this node against itself.
    const after = await tipRow();
    if(!after || Number(after.block_index) !== height || after.balances_root !== before.balances_root){
        console.error('refusing: the chain moved under the rebuild (tip was ' + height +
                      ', now ' + (after && after.block_index) + '). Re-run on a quiet chain.');
        process.exit(5);
    }

    await db.beginTransaction();
    try {
        await db.doQueryStrict(
            'UPDATE state_tree_roots SET balances_root=?, state_root=? WHERE chain=? AND network=? AND block_index=?',
            [rebuilt, stateRoot, opts.chain, opts.network, height]);
        await db.commitTransaction();
    } catch(e){
        await db.rollbackTransaction();
        throw e;
    }

    const verify = await tipRow();
    const ok = verify && verify.balances_root === rebuilt && verify.state_root === stateRoot;
    console.log('#');
    console.log('# APPLIED at block ' + height + ': ' + (ok ? 'verified' : 'VERIFY FAILED'));
    console.log('# the next block threads from the repaired root, so from here on the chain');
    console.log('# and a full rebuild agree. Rows below ' + height + ' are untouched on purpose.');
    if(db.close) await db.close();
    process.exit(ok ? 0 : 6);
})().catch(e => { console.error(e); process.exit(1); });
