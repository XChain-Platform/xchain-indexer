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
 * escrow_leaf_journal writer conformance (SPV sub-tree Stage B,
 * attributing ledger rows to their locker).
 *
 * THE ATTRIBUTION VECTORS ARE THE IMPORTANT TESTS HERE. The writer's totals are
 * the ledger's own rows re-keyed to their locker, so per-tick sums are conserved
 * BY CONSTRUCTION and no runtime check can see a row attributed to the wrong
 * locker within a tick. These vectors are the only guard on that: one per
 * recipient-keyed site family, asserting the exact locker each row resolves to,
 * with the ORDER_MATCH/SWAP_MATCH give/get orientation pinned in BOTH directions
 * (the two tables store opposite perspectives, which is precisely the mistake a
 * future edit would make).
 *
 * STUB HONESTY, as in the Stage A suites: the db stub honours the shape of each
 * query the writer issues; it cannot prove the SQL runs on MariaDB, only that
 * the attribution rules, accumulation, change-log semantics and fail-closed
 * throws behave as frozen.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const W = require('../../../src/consensus/escrowJournalWriter.js');
const { SO, RC, T1, makeDb, esc } = require('./escrow_journal_writer.test/helpers/journal_db.js');

// Action names an escrow-pushing handler can mint, DERIVED from the handler
// rather than assumed. The earlier version of this guard mapped one action
// name per file and passed while three real ones were unclassified
// (DISPENSER_EDIT, ORDER_CANCEL, SWAP_CANCEL): handlers RENAME their action
// after the fact via db.updateActionIndex, so a single file mints several
// names and the escrow row carries the renamed one. A live-venue replay
// found that; this now finds it statically.
function mintedActions(src, file){
    // The action the file is named for, which is the one its escrows.push
    // sites run under. A handler is either <name>.js or a directory
    // <name>/ holding index.js plus named parts, so the owning action is the
    // FIRST path segment of a nested file: execute/slash_emission.js carries
    // the EXECUTE contract-slash release and mints EXECUTE, not
    // SLASH_EMISSION, which is not an action at all.
    const owner = file.indexOf('/') === -1 ? file.replace(/\.js$/, '') : file.split('/')[0];
    const names = new Set([owner.toUpperCase()]);
    // ...plus every name it RENAMES that same action row to. This is the
    // mechanism the old guard missed. A synthetic sub-action minted inside a
    // handler (sweep.js mints an ISSUE row) is deliberately NOT collected:
    // it is a different action row, and if it ever carried an escrow it
    // would do so through its own handler.
    for(const m of src.matchAll(/updateActionIndex\([^)]*'([A-Z_]+)'/g)) names.add(m[1]);
    return names;
}

describe('escrow journal writer: attribution exhaustiveness @regression', function(){

    it('every action an escrow-pushing handler can mint has a frozen attribution rule', function(){
        const dir = path.resolve(__dirname, '../../../src/actions');
        const all = new Set();
        // Recursive: the nine largest handlers are directories, and the
        // EXECUTE contract-slash release lives in a named part beside its
        // index.js, so a flat read would stop seeing the one site this guard was
        // widened to catch and would pass vacuously.
        const handlerFiles = (d, prefix) => fs.readdirSync(d, { withFileTypes: true })
            .flatMap(e => e.isDirectory()
                ? handlerFiles(path.join(d, e.name), prefix + e.name + '/')
                : (e.name.endsWith('.js') ? [prefix + e.name] : []));
        for(const f of handlerFiles(dir, '')){
            // index.js at the TOP of the directory is the dispatch loader, not a handler.
            if(f === 'index.js') continue;
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            // Two ways a handler writes an escrow row: the escrows[] array it hands to
            // processTransactionLedgerChanges, and a direct db.createEscrow under its own
            // action_index (execute.js's contract-slash release does the latter). Scanning
            // only the first left the EXECUTE site invisible to this guard.
            if(src.indexOf('escrows.push(') === -1 && src.indexOf('createEscrow(') === -1) continue;
            for(const a of mintedActions(src, f)){
                all.add(a);
                assert.ok(W.SELF_ATTRIBUTING.has(a) || W.RESOLVERS[a],
                    'action ' + a + ' (minted by ' + f + ', which pushes escrow rows) has no attribution rule; ' +
                    'classify it in escrowJournalWriter.js before any chain containing it is armed');
            }
        }
        // Sanity that the derivation itself still sees the family it must: if a
        // refactor breaks the regexes, every assertion above passes vacuously.
        for(const expected of ['ORDER', 'ORDER_CANCEL', 'SWAP_CANCEL', 'DISPENSER_EDIT', 'BET', 'SWEEP',
                               'STAKE', 'SLASH', 'EXECUTE'])
            assert.ok(all.has(expected), 'the action-name derivation no longer finds ' + expected +
                '; the guard would pass vacuously');
        // The two sets must not overlap: a type resolving two ways is a fork.
        for(const a of Object.keys(W.RESOLVERS))
            assert.ok(!W.SELF_ATTRIBUTING.has(a), a + ' is classified both self-attributing and resolved');
    });
});

describe('escrow journal writer: attribution exhaustiveness @regression', function(){

    it('the whole DISPENSER family resolves through the dispenser row, never the row address', function(){
        // dispenser.js:350 admits a format-2 refill from the owner OR the
        // dispenser's GET_ADDRESS, so a DISPENSER_EDIT escrow row can carry an
        // address that is not the lock's owner, while every release pays out
        // against the dispenser's own SOURCE. Self-attributing any of them would
        // strand a positive on the refiller and drive the owner negative at
        // expiry: a fail-loud halt at the arming block.
        for(const a of Object.keys(W.DISPENSER_FAMILY)){
            assert.ok(W.RESOLVERS[a], a + ' must be resolved, not self-attributed');
            assert.ok(!W.SELF_ATTRIBUTING.has(a), a + ' must not be self-attributing');
        }
        // And the authority gate that forces this is still what it was.
        const disp = fs.readFileSync(path.resolve(__dirname, '../../../src/actions/dispenser/index.js'), 'utf8');
        assert.ok(/data\['SOURCE'\]!=dispenserInfo\['SOURCE'\] && data\['SOURCE'\]!=dispenserInfo\['GET_ADDRESS'\]/.test(disp),
            'dispenser edit authority changed; re-derive whether the family still needs row-resolution');
    });

    it('an UNKNOWN action type with an escrow row throws instead of guessing', async function(){
        const db = makeDb({ escrows: [esc(9, 'XFUTURE', RC, T1, 1, '5', 100)] });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /no attribution rule/);
    });

    it('a row whose refs do not survive the joins throws instead of vanishing', async function(){
        // The INNER JOINs drop rows with NULL/dangling address or tick refs; the
        // count cross-check turns that silent drop into a halt.
        const db = makeDb({ escrows: [esc(9, 'ORDER', SO, T1, 1, '5', 100)], phantomRows: 1 });
        await assert.rejects(() => W.writeEscrowJournal(db, 100), /unresolvable address\/tick\/action refs/);
    });
});

describe('escrow journal writer: block-path wiring @regression', function(){

    it('the SOURCE calls the writer, full:true exactly at the arming block and the shadow window start', function(){
        // Pinned at source level because both full-pass sites are one-shots: if
        // the flag is wrong at the arming block, nothing later notices and the
        // chain has already committed the wrong balances_root; if it is wrong at
        // the window start, the whole dry run shadows a journal missing every
        // position opened before the window.
        const sc = fs.readFileSync(path.resolve(__dirname, '../../../src/stateCommitment.js'), 'utf8');
        assert.ok(/EJW\.writeEscrowJournal\(db, blockIndex, \{ full: armingBlock \|\| windowStart \}\)/.test(sc),
            'computeAndStoreRoots must call the writer with the arming-or-window-start flag');
        // The TRUE arming block must full-replay even when a shadow ran right up
        // to it (armed-wins correction of a drifted shadow journal), so its
        // trigger is the ARMED map alone, never the shadow one.
        assert.ok(/armingBlock = escArmed && !SUB\.isEscrowLockedLeafActive\(blockIndex - 1/.test(sc),
            'the arming block is the first ARMED height, regardless of any preceding shadow window');
        assert.ok(/windowStart = escShadow && !SUB\.isEscrowLockedLeafShadowActive\(blockIndex - 1/.test(sc),
            'the window start is the first SHADOW height');
        const idx = sc.indexOf('EJW.writeEscrowJournal');
        const gate = sc.lastIndexOf('if(escArmed || escShadow)', idx);
        assert.ok(gate !== -1 && idx - gate < 800, 'the writer call must be gated on the escrow leaf being armed or shadowing');
    });

    it('the FOLLOWER never writes the journal (it replicates)', function(){
        // An absent follower still fails on the read below, as it always has. A present one
        // reached through a lane symlink into a live main checkout is refused instead of read.
        const followerVerdict = siblingCheckout(__dirname, '../../../../xchain-sync/src/stateCommitment.js');
        if (!followerVerdict.usable && fs.existsSync(followerVerdict.path))
            return skipOrFail(this, followerVerdict, 'the follower never-writes-the-journal pin');
        const follower = fs.readFileSync(
            path.resolve(__dirname, '../../../../xchain-sync/src/stateCommitment.js'), 'utf8');
        assert.ok(!/writeEscrowJournal/.test(follower),
            'xchain-sync must not write escrow_leaf_journal; it replicates the source\'s rows');
    });

    it('the writer never consults family aggregates, status predicates, or a clock', function(){
        // The failure mode this design retired: recomputing what "locked" means.
        // Comments are stripped so prose about the old design cannot trip it.
        // Entry plus every part, read as one text. Scanning the entry alone would pass
        // vacuously the moment a banned read moved into escrowJournalWriter/: this
        // guard grades ABSENCE, so a narrower read is a weaker guard that still looks green.
        const WRITER = path.resolve(__dirname, '../../../src/consensus/escrowJournalWriter.js');
        const PARTS  = path.resolve(__dirname, '../../../src/consensus/escrowJournalWriter');
        const src  = [WRITER]
            .concat(fs.readdirSync(PARTS).filter(f => f.endsWith('.js')).sort()
                .map(f => path.join(PARTS, f)))
            .map(f => fs.readFileSync(f, 'utf8')).join('\n');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for(const banned of ['getOrderAmountsRemaining', 'getDispenserAmountRemaining', 'getDispenserInfo',
                             'getAddressEscrows', "status = 'open'", 'bet_status'])
            assert.ok(code.indexOf(banned) === -1, 'writer must not use ' + banned + '; totals derive from the ledger rows');
    });
});
