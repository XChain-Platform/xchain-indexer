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
 * Verify a STAGE B (escrow locked-balance leaf) ARMING BOUNDARY against a
 * chain's own committed rows (SPV sub-tree spec §7, ).
 *
 * WHY THIS EXISTS, AND WHY IT IS A SECOND TOOL RATHER THAN A FLAG ON THE FIRST.
 * `bin/verify-arming-boundary.js` names  in its header and cannot serve
 * it: it hardcodes `contract_state_root` and every one of its assertions reads
 * a reserved SLOT COLUMN. Stage B has no slot and no column. It changes the
 * CONTENTS of `balances_root` under a second key domain (`XCHAIN_ESC`), so
 * "the slot went from NULL to non-NULL" has no analogue here, and the Stage A
 * tool would have to grow a second personality to fake one. The BTC regtest
 * Stage B arming at 11200 was therefore verified by hand, which is exactly the
 * situation the Stage A tool was written to end.
 *
 * THE HARD PART, AND WHY THE OBVIOUS CHECK IS NOT AVAILABLE. The arming was
 * originally proved by rebuilding `balances_root` with and without the locked
 * leaves and showing the armed root equalled the first while the pre-arming
 * root equalled the second. That check CANNOT be re-run later:
 * `buildFullBalancesRoot` reads the credits/debits ledger as it stands NOW,
 * with no height bound, so on any chain that kept processing it reproduces
 * neither root. A tool that ran it anyway would report a mismatch on a
 * perfectly healthy chain, which is worse than no tool.
 *
 * SO THIS ASSERTS THE SAME FACT A DIFFERENT WAY, FROM DATA THAT IS PERMANENT.
 * `state_tree_nodes` is copy-on-write, so the tree AS OF the arming height is
 * still reachable from that row's stored `balances_root`, and the journal is
 * append-only and block-indexed. That makes the central claim provable by
 * PROOF rather than by rebuild, and provable for as long as the nodes are
 * retained:
 *
 *   1. THE JOURNAL BEGINS AT EXACTLY H. Zero rows below the armed height and a
 *      non-empty arming batch AT it. This is Stage B's boundary-exactness
 *      check: the writer's first act on an armed chain is the from-genesis
 *      replay, so rows below H mean either a shadow window ran (report it,
 *      do not fail) or the writer fired at a height nobody armed.
 *   2. `balances_root` MOVED at H. Necessary, not sufficient on its own, which
 *      is why 4 and 5 exist.
 *   3. VERSION. `stateRootVersion` reports 2 at H. Stage B alone flips it; on a
 *      chain where a reserved slot armed LOWER the version is already 2 at
 *      H-1, so that is reported rather than asserted.
 *   4. THE LOCKED LEAF IS IN THE COMMITTED TREE AT H. A real key from the
 *      arming batch proves INCLUSION against the `balances_root` the chain
 *      committed at H, with a leaf equal to `escrowLeaf()` over that key's
 *      as-of-H journal amount. Two independent derivations of the same leaf.
 *   5. AND IT WAS NOT THERE AT H-1. The same key proves NON-INCLUSION against
 *      the root committed at H-1. Together with 4 this is the honest form of
 *      "the root moved by exactly the locked leaf set": the locked domain
 *      demonstrably entered the tree at the armed height and nowhere earlier.
 *   6. SELF-CONSISTENCY. The stored `state_root` at H reassembles from that
 *      row's OWN stored sub-roots, so the moved `balances_root` is really bound
 *      into what the chain signed.
 *   7. THREADING. The key is still included at the highest sampled row above H,
 *      against that row's own root and its own as-of-height journal amount.
 *
 * IT REFUSES RATHER THAN GUESSES WHEN THE EVIDENCE IS GONE. If the arming
 * height's `balances_root` has no row in `state_tree_nodes` (retention swept
 * the historical tree, which is legitimate), proofs 4, 5 and 7 would report
 * "absent" for keys that were genuinely present. The tool detects the missing
 * root node up front and exits 2 saying so, because a non-inclusion result read
 * off a pruned tree is the most misleading output this could produce.
 *
 * READ-ONLY. It opens one connection, reads, and writes nothing.
 *
 * USAGE (on a host that runs the indexer, service env loaded)
 *   node bin/verify-escrow-arming-boundary.js --chain BTC --network regtest
 *   node bin/verify-escrow-arming-boundary.js --chain BTC --network testnet --db XChain_BTC_Testnet_Indexer
 *
 * EXIT: 0 all assertions hold, 1 an assertion failed, 2 cannot run (no armed
 * height for this chain, the chain has not reached it, or the historical tree
 * is no longer retained).
 *
 *********************************************************************/

'use strict';

const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const M   = require(path.join(SRC, 'merkle.js'));
const SC  = require(path.join(SRC, 'stateCommitment.js'));
const SUB = require(path.join(SRC, 'state_subtree_activation.js'));
const ESC = require(path.join(SRC, 'escrowLeafSubtree.js'));

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

// Reassemble through the REAL assembler, never a local copy: a tool that
// reimplements the thing it verifies can agree with itself while both are wrong.
function assemble(row){
    const extra = {};
    for(const name of SUB.RESERVED_SUBTREES)
        if(row[name] != null) extra[name] = String(row[name]);
    return SC.assembleStateRoot(String(row.balances_root), String(row.stakes_root),
                                Object.keys(extra).length ? extra : null);
}

let failures = 0;
function check(ok, label, detail){
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
    if(!ok) failures++;
    return ok;
}
function note(label, detail){ console.log('  NOTE  ' + label + (detail ? '   ' + detail : '')); }

(async () => {
    const opts = parseArgs();

    const armed = SUB.ESCROW_LOCKED_LEAF_ACTIVATION[opts.chain + ':' + opts.network];
    if(armed === undefined){
        console.error('no armed escrow locked-leaf height for ' + opts.chain + ':' + opts.network +
                      '; nothing to verify (this is not a failure)');
        process.exit(2);
    }
    const H = Number(armed);
    console.log('# ' + opts.chain + '/' + opts.network + '  XCHAIN_ESC locked leaf armed at ' + H);

    const Database = require(path.join(SRC, 'db.js'));
    const config   = require(path.join(SRC, 'config.js'));
    const Utility  = require(path.join(SRC, 'utility.js'));
    const cfg  = config.getConfig(opts.chain, opts.network);
    const db   = new Database(process.env.INDEXER_DB_HOST, process.env.INDEXER_DB_PORT,
                              opts.db || process.env.INDEXER_DB_NAME,
                              process.env.INDEXER_DB_USER, process.env.INDEXER_DB_PASS,
                              { config: cfg, util: new Utility(cfg) });

    const done = async (code) => { if(db.close) await db.close(); process.exit(code); };

    // Only contract_state_root has a COLUMN today (§6), so name it explicitly
    // rather than selecting the whole RESERVED_SUBTREES list, which would fail
    // with errno 1054 on the two slots that have no column yet.
    const rows = await db.doQueryStrict(
        'SELECT block_index, balances_root, stakes_root, state_root, contract_state_root ' +
        'FROM state_tree_roots WHERE chain=? AND network=? AND block_index BETWEEN ? AND ? ' +
        'ORDER BY block_index',
        [opts.chain, opts.network, H - 1, H + 5]);

    const at = h => rows.find(r => Number(r.block_index) === h);
    const below = at(H - 1), armedRow = at(H);

    if(!armedRow){
        console.error('the chain has not reached ' + H + ' yet (or has no state_tree_roots row there); ' +
                      'nothing to verify');
        return done(2);
    }
    if(!below){
        console.error('no row at ' + (H - 1) + ': cannot compare across the boundary');
        return done(2);
    }

    // The historical tree must still be reachable, or every proof below reads
    // "absent" for reasons that have nothing to do with the arming.
    const emptyRoot = M.toHex(M.EMPTY_SMT_ROOT).toLowerCase();
    const armedBal  = String(armedRow.balances_root);
    if(armedBal.toLowerCase() === emptyRoot){
        console.error('the balances tree at ' + H + ' is EMPTY, so there is no locked leaf to prove; ' +
                      'this chain armed Stage B over an empty ledger and only the version flip is observable');
        return done(2);
    }
    const rootNode = await db.doQueryStrict(
        'SELECT 1 AS ok FROM state_tree_nodes WHERE node_hash=? LIMIT 1', [armedBal]);
    if(!rootNode.length){
        console.error('balances_root ' + armedBal.slice(0, 16) + '... at ' + H + ' has no row in ' +
                      'state_tree_nodes: the historical tree has been pruned, so inclusion and ' +
                      'non-inclusion cannot be distinguished. Refusing to report either.');
        return done(2);
    }

    // 1. The journal begins at exactly H.
    const jBelow = await db.doQueryStrict(
        'SELECT COUNT(*) AS n FROM escrow_leaf_journal WHERE block_index < ?', [H]);
    const jAt = await db.doQueryStrict(
        'SELECT COUNT(*) AS n FROM escrow_leaf_journal WHERE block_index = ?', [H]);
    const nBelow = Number(jBelow[0].n), nAt = Number(jAt[0].n);
    check(nBelow === 0, 'the journal is empty below the armed height',
        nBelow === 0 ? '' : nBelow + ' row(s) below ' + H + ': a shadow window, or a writer firing unarmed');
    check(nAt > 0, 'the arming block wrote its from-genesis replay batch', nAt + ' journal row(s) at ' + H);

    // 2. balances_root moved at the boundary.
    check(String(below.balances_root) !== armedBal, 'balances_root MOVED at the armed height',
        String(below.balances_root).slice(0, 16) + '... -> ' + armedBal.slice(0, 16) + '...');

    // 3. Version, derived from the gate at each row's OWN height.
    check(SUB.stateRootVersion(H, opts.network, opts.chain) === 2, 'state_root_version is 2 at ' + H);
    if(SUB.stateRootVersion(H - 1, opts.network, opts.chain) === 2)
        note('version was ALREADY 2 at ' + (H - 1),
             'a reserved slot armed lower on this chain, so the version flip is not Stage B\'s to claim here');
    else
        check(true, 'state_root_version is 1 at ' + (H - 1));

    // Pick a real key out of the arming batch: one whose as-of-H amount is a
    // live lock rather than a tombstone, since a tombstone commits no leaf.
    const touched = await ESC.touchedEscrowKeys(db, H);
    let subject = null, subjectLeaf = null;
    for(const t of touched){
        const amt  = await ESC.latestLockedAmount(db, t.address, t.tick, H);
        const leaf = ESC.escrowLeaf(amt);
        if(leaf){ subject = t; subjectLeaf = leaf; break; }
    }
    if(!subject){
        console.error('the arming batch at ' + H + ' contains no LIVE locked key (all tombstones), ' +
                      'so there is no leaf whose entry into the tree can be proved');
        return done(2);
    }
    console.log('# subject key: ' + subject.address + ' / ' + subject.tick);

    const smt    = new SC.PersistentSMT(new SC.DbNodeStore(db));
    const keyBuf = M.escrowKey(opts.chain, opts.network, subject.address, subject.tick);

    // 4. Included at H, with a leaf the journal independently derives.
    const pAt = await smt.prove(armedBal, keyBuf);
    const okAt = M.verifyCompressedSmtProof(armedBal, keyBuf, pAt.leaf_value, pAt.compressed);
    check(pAt.leaf_value != null && okAt, 'the locked leaf is INCLUDED in balances_root at ' + H,
        pAt.leaf_value ? String(pAt.leaf_value).slice(0, 16) + '...' : 'absent');
    check(pAt.leaf_value != null && String(pAt.leaf_value).toLowerCase() === subjectLeaf.toLowerCase(),
        'the committed leaf equals escrowLeaf() over the journal\'s as-of-' + H + ' amount',
        pAt.leaf_value ? '' : 'no leaf to compare');

    // 5. Absent at H-1. This is the assertion that makes 4 mean something.
    const belowBal = String(below.balances_root);
    if(belowBal.toLowerCase() === emptyRoot){
        check(true, 'the balances tree at ' + (H - 1) + ' was EMPTY, so the key was trivially absent');
    } else {
        const pBelow = await smt.prove(belowBal, keyBuf);
        const okBelow = M.verifyCompressedSmtProof(belowBal, keyBuf, pBelow.leaf_value, pBelow.compressed);
        check(pBelow.leaf_value == null && okBelow,
            'the same key proves NON-INCLUSION in balances_root at ' + (H - 1),
            pBelow.leaf_value ? 'present with ' + String(pBelow.leaf_value).slice(0, 16) + '...' : '');
    }

    // 6. Self-consistency of the armed row.
    const rebuilt = assemble(armedRow);
    check(rebuilt === String(armedRow.state_root),
        'stored state_root at ' + H + ' reassembles from its own sub-roots',
        rebuilt === String(armedRow.state_root) ? '' : rebuilt + ' != ' + armedRow.state_root);

    // 7. Threading: still committed above the boundary, against that row's own
    //    root and that height's own journal amount.
    const above = rows.filter(r => Number(r.block_index) > H);
    if(!above.length){
        console.log('  SKIP  no rows above ' + H + ' yet, so threading is unverified');
    } else {
        const top   = above[above.length - 1];
        const topH  = Number(top.block_index);
        const topBal = String(top.balances_root);
        const wantLeaf = ESC.escrowLeaf(await ESC.latestLockedAmount(db, subject.address, subject.tick, topH));
        const pTop = await smt.prove(topBal, keyBuf);
        const okTop = M.verifyCompressedSmtProof(topBal, keyBuf, pTop.leaf_value, pTop.compressed);
        if(wantLeaf == null)
            check(pTop.leaf_value == null && okTop,
                'the subject key was released by ' + topH + ' and is correctly ABSENT there');
        else
            check(pTop.leaf_value != null && okTop &&
                  String(pTop.leaf_value).toLowerCase() === wantLeaf.toLowerCase(),
                'the locked leaf is still committed at ' + topH + ' with that height\'s amount');
    }

    console.log(failures ? '\nFAILED: ' + failures + ' assertion(s)' : '\nALL ASSERTIONS HOLD');
    return done(failures ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
