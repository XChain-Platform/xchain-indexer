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
 * Verify a reserved sub-tree ARMING BOUNDARY against a chain's own committed
 * rows (SPV sub-tree spec §7).
 *
 * WHY THIS EXISTS. Both armings so far were verified by hand: someone read
 * state_tree_roots either side of the height, reassembled the roots in a
 * throwaway script, and wrote the result into the spec. That worked, and it does
 * not survive contact with the next one: the checks are easy to state, fiddly to
 * get right, and the interesting ones are the NEGATIVE controls that a hand run
 * is most likely to skip. Every future arming (testnet, then mainnet, then Stage
 * B behind each) needs the same five answers, so they belong in a re-runnable
 * tool that fails loudly rather than in a paragraph someone re-derives.
 *
 * WHAT IT ASSERTS, at the armed height H taken from the activation gate itself
 * (never from an argument, so the tool cannot be pointed at a height nobody
 * armed and report success):
 *
 *   1. BOUNDARY EXACTNESS. The slot column is NULL at H-1 and non-NULL at H.
 *      This is what pins the change to the height that was armed rather than to
 *      "somewhere around there".
 *   2. VERSION. stateRootVersion reports 1 at H-1 and 2 at H. The version is
 *      derived from the gate, and it is what flows through getblockhashes into
 *      the SIGNED checkpoint canonical, so a boundary that moves the leaf set
 *      without moving the version has validators signing "version 1" over a
 *      version-2 tree.
 *   3. SELF-CONSISTENCY. The stored state_root at H reassembles EXACTLY from
 *      that row's OWN stored sub-roots. If this fails, the row is internally
 *      inconsistent and every proof served at that height will be refused by
 *      _bindRoots.
 *   4. THE LEAF SET CHANGED FOR EXACTLY ONE REASON. Re-assembling row H WITHOUT
 *      the reserved slots (the v1 two-sub-root form) must reproduce the
 *      state_root that H-1 committed, PROVIDED the two rows' balances and stakes
 *      roots are equal. That proviso is the honest part: if the block also moved
 *      a balance, the comparison proves nothing, and the tool says so instead of
 *      pretending. This is the check that would have caught the Stage B hazard
 *      the spec worried about, where an arming block repairs dropped leaves in
 *      the same block that adds locked ones and the root moves for two reasons.
 *   5. THREADING. Rows above H keep committing a non-NULL slot. An arming that
 *      fires once and then reverts to NULL is a gate read from the wrong height.
 *
 * THE EMPTY-SLOT CASE IS EXPECTED, NOT A FAILURE. A chain with no rows in the
 * slot's source table commits EMPTY_SMT_ROOT there, which is byte-identical to
 * the padding an absent slot contributes (spec §2), so state_root does NOT move
 * across the boundary. That is exactly what BTC:testnet will do at 146500, where
 * contract_state is empty. The tool detects it, says so in as many words, and
 * still enforces 1, 2, 3 and 5, because the version flip and the boundary are
 * real even when the root is unchanged. Reporting "state_root did not move" as a
 * pass without saying WHY would be the most misleading output this could give.
 *
 * READ-ONLY. It opens one connection, reads, and writes nothing.
 *
 * USAGE (on a host that runs the indexer, service env loaded)
 *   node bin/verify-arming-boundary.js --chain BTC --network regtest
 *   node bin/verify-arming-boundary.js --chain BTC --network testnet --db XChain_BTC_Testnet_Indexer
 *
 * EXIT: 0 all assertions hold, 1 an assertion failed, 2 cannot run (no armed
 * height for this chain, or the chain has not reached it yet).
 *
 *********************************************************************/

'use strict';

const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const M   = require(path.join(SRC, 'merkle.js'));
const SC  = require(path.join(SRC, 'stateCommitment.js'));
const SUB = require(path.join(SRC, 'state_subtree_activation.js'));

const SLOT = 'contract_state_root';

function parseArgs(){
    const a = process.argv.slice(2), o = {};
    for(let i = 0; i < a.length; i++){
        switch(a[i]){
            case '--db':      o.db = a[++i]; break;
            case '--chain':   o.chain = a[++i]; break;
            case '--network': o.network = a[++i]; break;
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

// Reassemble state_root from a stored row through the REAL assembler, never a
// local copy of it: a tool that reimplements the thing it verifies can agree with
// itself while both are wrong. `withSlots` false gives the v1 two-sub-root form,
// which is what the chain committed before any slot armed.
function assemble(row, withSlots){
    let extra = null;
    if(withSlots){
        extra = {};
        // Every reserved slot the row actually carries a column for. A slot with
        // no column contributes nothing, which is exactly what an absent slot
        // means to the assembler (spec §2).
        for(const name of SUB.RESERVED_SUBTREES)
            if(row[name] != null) extra[name] = String(row[name]);
    }
    return SC.assembleStateRoot(String(row.balances_root), String(row.stakes_root), extra);
}

let failures = 0;
function check(ok, label, detail){
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
    if(!ok) failures++;
    return ok;
}

(async () => {
    const opts = parseArgs();

    const armed = SUB.STATE_SUBTREE_ACTIVATION[SLOT][opts.chain + ':' + opts.network];
    if(armed === undefined){
        console.error('no armed ' + SLOT + ' height for ' + opts.chain + ':' + opts.network +
                      '; nothing to verify (this is not a failure)');
        process.exit(2);
    }
    const H = Number(armed);
    console.log('# ' + opts.chain + '/' + opts.network + '  ' + SLOT + ' armed at ' + H);

    const Database = require(path.join(SRC, 'db.js'));
    const config   = require(path.join(SRC, 'config.js'));
    const Utility  = require(path.join(SRC, 'utility.js'));
    const cfg  = config.getConfig(opts.chain, opts.network);
    const db   = new Database(process.env.INDEXER_DB_HOST, process.env.INDEXER_DB_PORT,
                              opts.db || process.env.INDEXER_DB_NAME,
                              process.env.INDEXER_DB_USER, process.env.INDEXER_DB_PASS,
                              { config: cfg, util: new Utility(cfg) });

    // Only contract_state_root has a COLUMN today: §6 leaves the other two
    // reserved slots without one until each gains a derivation, so selecting the
    // whole RESERVED_SUBTREES list would fail with errno 1054. When a second slot
    // gains a column, add it here and the assembly below picks it up.
    const cols = 'block_index, balances_root, stakes_root, state_root, ' + SLOT;
    const rows = await db.doQueryStrict(
        'SELECT ' + cols + ' FROM state_tree_roots WHERE chain=? AND network=? ' +
        'AND block_index BETWEEN ? AND ? ORDER BY block_index',
        [opts.chain, opts.network, H - 1, H + 5]);

    const at = h => rows.find(r => Number(r.block_index) === h);
    const below = at(H - 1), armedRow = at(H);

    if(!armedRow){
        console.error('the chain has not reached ' + H + ' yet (or has no state_tree_roots row there); ' +
                      'nothing to verify');
        if(db.close) await db.close();
        process.exit(2);
    }
    if(!below){
        console.error('no row at ' + (H - 1) + ': cannot compare across the boundary');
        if(db.close) await db.close();
        process.exit(2);
    }

    // 1. Boundary exactness.
    check(below[SLOT] == null, 'slot is NULL below the boundary (' + (H - 1) + ')');
    check(armedRow[SLOT] != null, 'slot is committed AT the boundary (' + H + ')',
        armedRow[SLOT] ? String(armedRow[SLOT]).slice(0, 16) + '...' : '');

    // 2. Version, derived from the gate at each row's OWN height.
    check(SUB.stateRootVersion(H - 1, opts.network, opts.chain) === 1, 'state_root_version is 1 at ' + (H - 1));
    check(SUB.stateRootVersion(H,     opts.network, opts.chain) === 2, 'state_root_version is 2 at ' + H);

    // 3. Self-consistency of the armed row.
    const rebuilt = assemble(armedRow, true);
    check(rebuilt === String(armedRow.state_root),
        'stored state_root at ' + H + ' reassembles from its own sub-roots',
        rebuilt === String(armedRow.state_root) ? '' : rebuilt + ' != ' + armedRow.state_root);

    // Is the armed slot EMPTY? Then §2 says state_root cannot have moved.
    const emptyRoot = M.toHex(M.EMPTY_SMT_ROOT);
    const slotIsEmpty = String(armedRow[SLOT]).toLowerCase() === emptyRoot.toLowerCase();

    // 4. The leaf set changed for exactly one reason. Only meaningful when the
    //    other two sub-roots did not move across the boundary.
    const sameBase = String(below.balances_root) === String(armedRow.balances_root) &&
                     String(below.stakes_root)   === String(armedRow.stakes_root);
    if(!sameBase){
        console.log('  SKIP  the arming block also moved balances/stakes, so a root comparison ' +
                    'across it proves nothing (see the header)');
    } else {
        const v1OfArmed = assemble(armedRow, false);
        check(v1OfArmed === String(below.state_root),
            'the v1 assembly of ' + H + ' reproduces what ' + (H - 1) + ' committed',
            v1OfArmed === String(below.state_root) ? '' : v1OfArmed + ' != ' + below.state_root);

        const moved = String(armedRow.state_root) !== String(below.state_root);
        if(slotIsEmpty)
            check(!moved, 'the armed slot is EMPTY, so state_root did NOT move (spec §2)',
                'an armed-but-empty slot commits EMPTY_SMT_ROOT, byte-identical to an absent one; ' +
                'the VERSION flip is the whole observable effect here');
        else
            check(moved, 'the armed slot carries content, so state_root DID move',
                String(below.state_root).slice(0, 16) + '... -> ' + String(armedRow.state_root).slice(0, 16) + '...');
    }

    // 5. Threading above the boundary.
    const above = rows.filter(r => Number(r.block_index) > H);
    if(!above.length)
        console.log('  SKIP  no rows above ' + H + ' yet, so threading is unverified');
    else
        check(above.every(r => r[SLOT] != null),
            'every row above the boundary still commits the slot (' + above.length + ' checked)');

    console.log(failures ? '\nFAILED: ' + failures + ' assertion(s)' : '\nALL ASSERTIONS HOLD');
    if(db.close) await db.close();
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
