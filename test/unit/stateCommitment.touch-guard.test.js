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
 * The touched-set guard : a block whose ledger moved keys the
 * commitment did not apply must be REFUSED, not committed.
 *
 * Balance leaves have gone missing on every regtest venue (BTC 15 of 1531
 * ledger-changing blocks, LTC 8 of 880, DOGE 2 of 648). Two defects were found
 * and fixed, both mis-diagnosed at least once first, and block 10296 then
 * skipped under conditions that exclude both, so at least one mechanism is still
 * unknown. What every mechanism shares is not a cause but SILENCE: the update
 * becomes a no-op, the root does not move, nothing errors, and every peer
 * running the same code agrees. This guard closes the class instead of chasing
 * causes, which is what protects against the mechanisms not yet found.
 *
 * The subset direction is the load-bearing design decision and is tested
 * hardest. `extra` (applied minus expected) has LEGITIMATE causes and must never
 * halt a chain: escrows are recorded as touches but are not in the expected set,
 * and backdated cooldown-refund credits are captured in the block that writes
 * them while a block-range query attributes them to the block that owns the
 * action. Enforcing equality would halt healthy chains.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const SC      = require('../../src/stateCommitment.js');
const M       = require('../../src/merkle.js');
const Utility = require('../../src/utility.js');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/stateCommitment.js'), 'utf8');

// The guard is module-private and sits inside computeAndStoreRoots' incremental
// branch, which needs a live schema to drive end to end. Behaviour is therefore
// exercised by re-implementing NOTHING: the assertions below read the real
// source for the properties that decide whether a chain halts, which is what a
// reviewer would otherwise have to eyeball. Stated plainly so nobody mistakes
// this for execution coverage.
//
//  is why the second suite in this file EXECUTES instead. Nine source-shape
// cases all passed a guard that could not detect the fault class it was added
// for, because every one of them pinned set semantics and not one asserted that
// a leaf was written. Shape tests cannot catch that; a driven block can.
describe('touched-set guard @regression', function(){

    it('is ON by default: no env flag gates the check itself', function(){
        // The whole point is that it protects nodes nobody remembered to
        // configure. A gate here would put it back to opt-in.
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(!/INDEXER_SMT_TOUCH_AUDIT[^\n]*\)\s*return;/.test(body),
            'the guard must not return early on an audit flag');
        assert.ok(!/^\s*if\s*\(process\.env\.INDEXER_TOUCH_GUARD[^\n]*\)\s*return;/m.test(body),
            'the guard must not be switched off wholesale by an env var');
    });

    it('ENFORCES only the missing direction, never extra', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        // The throw must be reached from `missing`, and `extra` must not throw:
        // escrows and backdated cooldown credits legitimately land in extra, so
        // enforcing equality would halt healthy chains.
        assert.ok(/if\(!missing\.length\) return;/.test(body),
            'a clean subset must return before the throw');
        const extraIdx = body.indexOf('const extra');
        const throwIdx = body.indexOf('throw new Error(msg)');
        assert.ok(extraIdx > -1 && throwIdx > extraIdx,
            'extra is computed for reporting only, ahead of the missing-driven throw');
        const extraBlock = body.slice(extraIdx, body.indexOf('if(!missing.length)'));
        assert.ok(!/throw/.test(extraBlock), 'extra must never throw');
    });

    it('reports extra only under the audit flag, because it is noisy by design', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/INDEXER_SMT_TOUCH_AUDIT === '1'[\s\S]{0,400}extra/.test(body),
            'extra reporting is gated so healthy chains do not log escrow keys every block');
    });

    it('reads STRICTLY, so a failed check can never pass as clean', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/doQueryStrict\(/.test(body) && !/[^t]\bdb\.doQuery\(/.test(body),
            'through doQuery a failed read returns [], which the guard would read as ' +
            '"the ledger moved nothing" and pass every block: worse than no guard at all');
    });

    it('does NOT swallow its own errors (that was the diagnostic contract, not the guard one)', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(!/catch\s*\(/.test(body),
            'a swallowed failure is a silent pass, which is exactly the property being fixed');
    });

    it('has an operational downgrade that is documented as divergence, not a knob', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/INDEXER_TOUCH_GUARD === 'warn'/.test(body), 'a safety valve must exist');
        assert.ok(/diverge/.test(body),
            'the warn path must say plainly that the node commits a root it knows is incomplete');
    });

    it('runs on the incremental branch only', function(){
        // The full-rebuild branch derives from the entire ledger and cannot skip
        // a key, so guarding it would cost a query for no possible finding.
        assert.ok(/await _enforceTouchedSet\(db, blockIndex, touched\);/.test(SRC));
        const guardCall = SRC.indexOf('await _enforceTouchedSet(db, blockIndex, touched)');
        const fullBuild = SRC.indexOf('balancesRoot = await buildFullBalancesRoot(db, chain, network, blockIndex);');
        assert.ok(guardCall > fullBuild,
            'the guard belongs after the incremental branch, not on the full-rebuild path');
    });

    it('returns early when the block moved no ledger keys (the common case is free)', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/if\(!expected\.size\) return;/.test(body),
            'a block with no ledger rows must cost nothing beyond the one query');
    });

    it('names the block and the exact keys in the failure', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/block ' \+ blockIndex/.test(body), 'the operator needs the height');
        assert.ok(/keys=' \+ detail/.test(body),
            'and the keys, which are unrecoverable once the block is past');
        assert.ok(//.test(body), 'and a pointer to the investigation');
    });
});

// ---- : the leaf-presence half, driven ---------------------------------

const CHAIN   = 'LTC';        // LTC keeps the BTC-only stakes path out, and neither
const NETWORK = 'regtest';    // contract_state_root nor the escrow leaf arms here
const HEIGHT  = 500;

// Mock db for computeAndStoreRoots: state_tree_nodes in memory, every other query
// routed by SQL shape. Routing order is load-bearing. The ledger-key query and
// the net-balance scan both mention `credits`, and only the ledger-key query
// joins `actions`, so it must be matched first or the block sees phantom keys.
//
// `nets` maps an (address, tick) key to the net that getNetBalance will report.
// An ARRAY is the  fault injection: the read is answered in sequence and
// the last value sticks, so ['0','1000'] models exactly the observed fault, a
// commit-time resolution that answered zero for a key whose authoritative net is
// not zero. That is the shape no set comparison can see, because the key is
// present in `applied` the whole time.
function makeBlockMockDb({ ledgerKeys, touched, nets, seedLeaves }){
    const nodes     = new Map();
    const persisted = {};
    const calls     = { netReads: 0, descents: 0 };

    const route = async (sql, params) => {
        if(/FROM state_tree_nodes/.test(sql)){
            calls.descents++;
            const v = nodes.get(params[0]);
            return v ? [v] : [];
        }
        if(/INSERT IGNORE INTO state_tree_nodes/.test(sql)){
            // (hash, left, right) triples: putMany batches a whole path into one
            // multi-row statement , so consuming only params[0..2] would
            // drop every node but the first and leave _descend reading the gaps as
            // empty subtrees.
            for(let i = 0; i + 2 < params.length; i += 3)
                if(!nodes.has(params[i]))
                    nodes.set(params[i], { left_hash: params[i + 1], right_hash: params[i + 2] });
            return [];
        }
        if(/UNION ALL/.test(sql) && /INNER JOIN actions/.test(sql))
            return (ledgerKeys || []).map(k => ({ address: k[0], tick: k[1] }));
        if(/AS cr/.test(sql)){
            calls.netReads++;
            const key  = params[0] + '\t' + params[1];
            const spec = (nets || {})[key];
            const net  = Array.isArray(spec) ? (spec.length > 1 ? spec.shift() : spec[0])
                                             : (spec == null ? '0' : spec);
            return [{ cr: net, dr: '0' }];
        }
        if(/UNION ALL/.test(sql) && /credits/.test(sql))
            return [];   // full-recompute scan: unused, this suite is incremental only
        if(/SELECT balances_root FROM state_tree_roots/.test(sql))
            return [{ balances_root: priorRoot }];
        if(/INSERT INTO\s+state_tree_roots/.test(sql)){
            persisted.balances_root = params[3];
            return [];
        }
        return [];
    };

    const db = {
        _smtTouched:      new Set(touched || []),
        config:           {},
        util:             new Utility({}),
        getBlockLeafRows: async () => [],
        doQuery:          route,
        doQueryStrict:    route
    };

    // Seed the prior root so the assertion descends a real tree rather than
    // short-circuiting at an empty root: an absent-leaf check that only ever ran
    // against EMPTY would prove nothing about a populated chain.
    let priorRoot = SC.EMPTY_ROOT_HEX;
    const smt = new SC.PersistentSMT(new SC.DbNodeStore(db));
    const seed = async () => {
        for(const [address, tick, amount] of (seedLeaves || []))
            priorRoot = await smt.update(priorRoot, M.balanceKey(CHAIN, NETWORK, address, tick),
                M.toHex(M.leafHash(M.canonicalAmount(amount))));
        calls.descents = 0;
        calls.netReads = 0;
        return priorRoot;
    };
    return { db, smt, persisted, calls, seed, priorRoot: () => priorRoot };
}

async function leafPresent(smt, rootHex, address, tick){
    const proof = await smt.prove(rootHex, M.balanceKey(CHAIN, NETWORK, address, tick));
    return proof.leaf_value != null;
}

describe('leaf-presence assertion  @regression', function(){

    it('REFUSES the block when a touched key resolves to a null leaf and its leaf never lands', async function(){
        // The  signature: the key is in the ledger AND in the touched set,
        // so the set guard is satisfied in both directions, yet no leaf exists.
        const h = makeBlockMockDb({
            ledgerKeys: [['addr1', 'TICK']],
            touched:    ['addr1\tTICK'],
            nets:       { 'addr1\tTICK': ['0', '1000'] },
            seedLeaves: [['addr2', 'TICK', '5']]
        });
        await h.seed();

        await assert.rejects(
            () => SC.computeAndStoreRoots(h.db, CHAIN, NETWORK, HEIGHT, false),
            err => {
                assert.match(err.message, /leaf-presence assertion FAILED at block 500/);
                assert.match(err.message, /addr1/, 'the operator needs the key');
                assert.match(err.message, /TICK/);
                assert.match(err.message, /1000/, 'and the net that proves it was not a delete');
                assert.match(err.message, //);
                return true;
            });

        assert.strictEqual(h.persisted.balances_root, undefined,
            'a refused block must not write its state_tree_roots row');
    });

    it('keeps a net-zero key LEGAL: an absent leaf with a zero net is delete-on-zero, not a fault', async function(){
        // The reason this cannot simply enforce presence. A supply-0 ISSUE, or a
        // credit and debit cancelling inside one block, has no leaf BY DESIGN and
        // is why a healthy block can leave balances_root untouched.
        const h = makeBlockMockDb({
            ledgerKeys: [['addr1', 'TICK']],
            touched:    ['addr1\tTICK'],
            nets:       { 'addr1\tTICK': '0' },
            seedLeaves: [['addr2', 'TICK', '5']]
        });
        const seeded = await h.seed();

        const out = await SC.computeAndStoreRoots(h.db, CHAIN, NETWORK, HEIGHT, false);
        assert.strictEqual(out.balances_root, seeded, 'a net-zero key must not move the root');
        assert.strictEqual(h.persisted.balances_root, seeded, 'and the block must still commit');
    });

    it('passes a healthy block, and does not re-read the net for a leaf that landed', async function(){
        const h = makeBlockMockDb({
            ledgerKeys: [['addr1', 'TICK']],
            touched:    ['addr1\tTICK'],
            nets:       { 'addr1\tTICK': '1000' },
            seedLeaves: [['addr2', 'TICK', '5']]
        });
        const seeded = await h.seed();

        const out = await SC.computeAndStoreRoots(h.db, CHAIN, NETWORK, HEIGHT, false);
        assert.notStrictEqual(out.balances_root, seeded, 'the leaf must move the root');
        assert.strictEqual(await leafPresent(h.smt, out.balances_root, 'addr1', 'TICK'), true);
        assert.strictEqual(await leafPresent(h.smt, out.balances_root, 'addr2', 'TICK'), true,
            'and must not disturb the leaf that was already there');
        assert.strictEqual(h.calls.netReads, 1,
            'the net is read once by the commit loop; the assertion defers its own read ' +
            'until a leaf is actually absent, so a healthy block pays no extra history scan');
    });

    it('catches the key the commitment applied under the WRONG name (the reproduced cache fault)', async function(){
        // Block 10818: the same address under a stale ticker name. The set guard
        // caught that one; this proves the assertion is not weaker, and does it
        // without consulting the touched set at all.
        const h = makeBlockMockDb({
            ledgerKeys: [['addr1', 'PFX517776']],
            touched:    ['addr1\tPFX925430'],
            nets:       { 'addr1\tPFX517776': '1000', 'addr1\tPFX925430': '7' },
            seedLeaves: []
        });
        const root = await h.seed();
        const smt  = new SC.PersistentSMT(new SC.DbNodeStore(h.db));
        // Apply the block exactly as the commitment did: under the stale name.
        const applied = await smt.update(root, M.balanceKey(CHAIN, NETWORK, 'addr1', 'PFX925430'),
            M.toHex(M.leafHash(M.canonicalAmount('7'))));

        await assert.rejects(
            () => SC._assertCommittedLeaves(h.db, smt, CHAIN, NETWORK, 10818, applied),
            /leaf-presence assertion FAILED at block 10818[\s\S]*PFX517776/);
    });

    it('downgrades to a log under INDEXER_TOUCH_GUARD=warn, and says the node will diverge', async function(){
        const h = makeBlockMockDb({
            ledgerKeys: [['addr1', 'TICK']],
            touched:    ['addr1\tTICK'],
            nets:       { 'addr1\tTICK': ['0', '1000'] },
            seedLeaves: [['addr2', 'TICK', '5']]
        });
        const seeded = await h.seed();

        const logged   = [];
        const realErr  = console.error;
        const realGuard = process.env.INDEXER_TOUCH_GUARD;
        console.error = (...a) => logged.push(a.join(' '));
        process.env.INDEXER_TOUCH_GUARD = 'warn';
        try {
            const out = await SC.computeAndStoreRoots(h.db, CHAIN, NETWORK, HEIGHT, false);
            assert.strictEqual(out.balances_root, seeded);
        } finally {
            console.error = realErr;
            if(realGuard === undefined) delete process.env.INDEXER_TOUCH_GUARD;
            else process.env.INDEXER_TOUCH_GUARD = realGuard;
        }
        assert.strictEqual(logged.length, 1, 'the valve logs instead of throwing');
        assert.match(logged[0], /leaf-presence assertion FAILED/);
        assert.match(logged[0], /diverge/,
            'and says plainly that the node commits a root it knows is incomplete');
    });

    it('touches nothing when the block moved no ledger keys', async function(){
        const h = makeBlockMockDb({ ledgerKeys: [], touched: [], nets: {}, seedLeaves: [] });
        await h.seed();
        const smt = new SC.PersistentSMT(new SC.DbNodeStore(h.db));
        await SC._assertCommittedLeaves(h.db, smt, CHAIN, NETWORK, HEIGHT, SC.EMPTY_ROOT_HEX);
        assert.strictEqual(h.calls.descents, 0, 'no key to prove means no descent');
        assert.strictEqual(h.calls.netReads, 0);
    });

    it('is wired AFTER the final root, on the incremental branch only', function(){
        // The full-rebuild branch derives from the whole ledger and cannot drop a
        // key, and the value proved has to be the value written, so the call site
        // matters as much as the check.
        const assertCall = SRC.indexOf('await _assertCommittedLeaves(db, smt, chain, network, blockIndex, balancesRoot);');
        const finalRoot  = SRC.indexOf('balancesRoot = root;');
        const insertRow  = SRC.indexOf('INSERT INTO state_tree_roots');
        const fullBuild  = SRC.indexOf('balancesRoot = await buildFullBalancesRoot(db, chain, network, blockIndex);');
        assert.ok(assertCall > -1, 'the assertion must be called from the block path');
        assert.ok(assertCall > finalRoot, 'it must prove the root that is about to be committed');
        assert.ok(assertCall < insertRow, 'and it must run BEFORE the row is written');
        assert.ok(assertCall > fullBuild, 'it belongs to the incremental branch');
    });

    it('does not assert leaf VALUE equality, which would cost a history scan per key per block', function(){
        const body = SRC.slice(SRC.indexOf('async function _assertCommittedLeaves'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/proof\.leaf_value != null\) continue;/.test(body),
            'a landed leaf ends the check for that key');
        assert.ok(!/leafHash/.test(body),
            'the fault class is absence; re-hashing the net here would re-check a value ' +
            'this same block wrote from that same query, at O(history) per moved key');
    });
});
