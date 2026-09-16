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
 * The carrier logic pin's operations and membership rules: what each repo
 * pins, and how an entry is re-pinned, added, retired or moved. The hashing,
 * reading, writing and measuring of a pin stay in carrier_logic_pin.js; this
 * half is everything that decides WHICH files are carriers and rewrites the
 * pin on purpose.
 *
 * WHY A FACTORY. This file is a byte-identical twin in xchain-indexer,
 * xchain-sync and xchain-hub beside carrier_logic_pin.js, which requires it
 * and re-exports what it returns. Taking the core's primitives as an argument
 * instead of requiring the core back keeps the two twins a one-way layering
 * (core over ops), so neither copy can load a half-built sibling.
 *
 * MEMBERSHIP is read from the tree AND the pin: the activation and gate files
 * the tree holds, plus a FIXED list of carrier ids whose path is whatever the
 * pin says it is (so a moved fixed carrier stays a member). A member the pin
 * does not hold is reported as NEW under an id derived from its path; the
 * unit test requires the member set and the pin's paths to be equal.
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const path  = require('path');
const acorn = require('acorn');

/**
 * The carrier ids the deleted v1 fingerprint module listed as FIXED_GATE_FILES,
 * frozen here as the ids the pin holds them under (the non-activation entries
 * of each repo's pin when v1 went, minus the digest module, which is listed by
 * its own rule below). Ids, not paths: a fixed carrier that moves keeps its
 * id and the pin's `path` field says where it is now.
 */
const FIXED_CARRIER_IDS = {
    'xchain-indexer': [
        'attestation/providerMinStakeHistory',
        'capability_min_stake_history',
        'equivocation_header',
        'protocol/constants',
        'protocol_changes',
        'snapshot_reorg_buffer',
        'stake_weighted_quorum',
        'stateHash',
    ],
    'xchain-sync': [
        'consensus-constants',
        'equivocation_header',
        'stake_weighted_quorum',
        'stateHash',
    ],
};

/** Today's date for a repins record, from the clock at the moment of the write. */
function today() { return new Date().toISOString().slice(0, 10); }

/**
 * @param {object} core the primitives of carrier_logic_pin.js:
 *   TOKENIZER_OPTS, PIN_REL, hashFile, moduleId, repoName, readPin, writePin
 * @returns {object} the operations, re-exported by the core
 */
module.exports = function carrierLogicPinOps(core) {
    const { TOKENIZER_OPTS, PIN_REL, hashFile, moduleId, repoName, readPin, writePin } = core;

    /** The initialiser of `const <name> = ...` in `source`, read from the AST rather than restated here. */
    function constInit(source, name) {
        const ast = acorn.parse(source, TOKENIZER_OPTS);
        for (const node of ast.body) {
            if (node.type !== 'VariableDeclaration') continue;
            for (const decl of node.declarations) {
                if (decl.id.type === 'Identifier' && decl.id.name === name) return decl.init;
            }
        }
        throw new Error(`${name} is not declared at the top level`);
    }

    /** The top-level `*_activation.js` files of `src/`, as repo-relative paths. */
    function activationFiles(dir, sub) {
        const rel = sub ? `src/${sub}` : 'src';
        let names;
        try { names = fs.readdirSync(path.join(dir, rel)); } catch (e) { return []; }
        return names.filter((f) => f.endsWith('_activation.js')).sort().map((f) => `${rel}/${f}`);
    }

    /** The require specifiers of `source`, read from the token stream (a comment naming a module is not a require). */
    function requireSpecifiers(source) {
        const out = [];
        const priorTwo = ['', ''];
        for (const tok of acorn.tokenizer(source, TOKENIZER_OPTS)) {
            if (tok.type.label === 'string' && priorTwo[0] === 'name:require' && priorTwo[1] === '(:') out.push(tok.value);
            priorTwo[0] = priorTwo[1];
            priorTwo[1] = `${tok.type.label}:${tok.value === undefined ? '' : String(tok.value)}`;
        }
        return out;
    }

    /** True when `source` requires the gate registry (`consensus/gate_registry` or the `protocol_changes` entry it aliases). */
    function readsGateRegistry(source) {
        return requireSpecifiers(source).some((spec) => /(^|\/)(gate_registry|protocol_changes)(\.js)?$/.test(spec));
    }

    /**
     * Every `*_gate.js` under src/ (any depth) whose module reads the gate
     * registry: the shape a renamed logic-bearing activation module takes. A
     * `_gate.js` that gates something else (an API key, a release train through
     * a shim) is not a carrier and is left out by the same test.
     */
    function gateFiles(dir) {
        const out = [];
        const walk = (rel) => {
            let names;
            try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (e) { return; }
            for (const ent of names) {
                const relPath = `${rel}/${ent.name}`;
                if (ent.isDirectory()) walk(relPath);
                else if (ent.name.endsWith('_gate.js') && readsGateRegistry(fs.readFileSync(path.join(dir, relPath), 'utf8'))) out.push(relPath);
            }
        };
        walk('src');
        return out.sort();
    }

    /**
     * The paths of the fixed carriers: the pin's path for a pinned id, else the
     * id's default home `src/<id>.js`; a carrier absent from the tree is left out
     * (a pinned one is then a measure() miss, which is the finding that matters).
     */
    function fixedCarrierPaths(dir, pin, ids) {
        return ids.map((id) => (pin && pin.entries && pin.entries[id] ? pin.entries[id].path : `src/${id}.js`))
            .filter((rel) => fs.existsSync(path.join(dir, rel)));
    }

    /**
     * The hub's gate carriers, the same set its frozen-set check freezes: every
     * activation file at the top level and under src/lib, every SHARED_GATES
     * carrier at src/<name>.js, and the digest module that computes the requires.
     */
    function hubMembers(dir, pin) {
        const source = fs.readFileSync(path.join(dir, 'src/consensus_rules_digest.js'), 'utf8');
        // A SHARED_GATES stem lives at its pinned path once W5 has moved it
        // (src/consensus/gates/<stem>_gate.js, src/consensus/<carrier>.js or a
        // hub-owned home such as src/attestation/); the pin already records
        // that path per id, so read it there rather than restating the loader's
        // move table. A stem with no pin entry yet (before --init) falls back
        // to the pre-W5 flat path.
        const ids = Array.from(new Set(constInit(source, 'SHARED_GATES').elements.map((row) => row.elements[0].value)));
        const shared = ids.map((id) => (pin && pin.entries && pin.entries[id] ? pin.entries[id].path : `src/${id}.js`));
        return activationFiles(dir).concat(activationFiles(dir, 'lib'), gateFiles(dir), shared, ['src/consensus_rules_digest.js'])
            .filter((rel) => fs.existsSync(path.join(dir, rel)));
    }

    /**
     * The paths this repo pins, by the repo's package name, deduplicated and
     * sorted. Read from the tree and the pin: the pin only supplies the current
     * path of a fixed carrier, so a checkout without one (before --init) lists
     * the defaults.
     * @param {string} dir a checkout
     * @param {object|null} [pin] the checkout's pin when it has one
     * @returns {string[]} repo-relative posix paths
     */
    function members(dir, pin) {
        const name = repoName(dir);
        let list;
        if (name === 'xchain-indexer') {
            list = activationFiles(dir)
                .concat(gateFiles(dir), fixedCarrierPaths(dir, pin, FIXED_CARRIER_IDS[name]), ['src/consensus_rules_digest.js'])
                .filter((rel) => fs.existsSync(path.join(dir, rel)));
        } else if (name === 'xchain-sync') {
            list = activationFiles(dir).concat(gateFiles(dir), fixedCarrierPaths(dir, pin, FIXED_CARRIER_IDS[name]));
        } else if (name === 'xchain-hub') {
            list = hubMembers(dir, pin);
        } else {
            throw new Error(`no membership rule for ${name}`);
        }
        return Array.from(new Set(list)).sort();
    }

    /**
     * The id a repo-relative path is pinned under, else the id its path derives.
     * The pin is the mapping: a module keeps its first id across a move, so a
     * `_gate.js` file at a feature path resolves to the stem it was pinned as.
     * @param {object|null} pin the pin, or null before --init
     * @param {string} rel repo-relative posix path
     * @returns {string}
     */
    function idForPath(pin, rel) {
        if (pin && pin.entries) {
            for (const id of Object.keys(pin.entries)) {
                if (pin.entries[id].path === rel) return id;
            }
        }
        return moduleId(rel);
    }

    /**
     * The members as `{ id, path, pinned }` rows: the pinned id where the pin
     * holds the path, else the id the path derives (a NEW member).
     * @returns {{id: string, path: string, pinned: boolean}[]}
     */
    function memberEntries(dir, pin) {
        const pinnedPaths = new Set(pin && pin.entries ? Object.keys(pin.entries).map((id) => pin.entries[id].path) : []);
        return members(dir, pin).map((rel) => ({ id: idForPath(pin, rel), path: rel, pinned: pinnedPaths.has(rel) }));
    }

    /**
     * The membership against the pin, both ways: members the pin does not hold,
     * and pinned paths the membership rule no longer yields.
     * @returns {{unpinned: {id: string, path: string}[], nonMembers: {id: string, path: string}[]}}
     */
    function membershipDiff(dir, pin) {
        const rows = memberEntries(dir, pin);
        const memberPaths = new Set(rows.map((r) => r.path));
        const unpinned = rows.filter((r) => !r.pinned).map((r) => ({ id: r.id, path: r.path }));
        const nonMembers = Object.keys(pin.entries).sort()
            .filter((id) => !memberPaths.has(pin.entries[id].path))
            .map((id) => ({ id, path: pin.entries[id].path }));
        return { unpinned, nonMembers };
    }

    /**
     * Add or replace one entry, recording the move. Refused when the file is
     * absent or when the hash has not moved, because a record of nothing is noise.
     */
    function pinEntry(dir, pin, id, rel, reason, twins) {
        const hash = hashFile(dir, rel);
        if (hash === null) throw new Error(`${rel} does not exist under ${dir}`);
        const before = pin.entries[id];
        if (before && before.hash === hash && before.path === rel) throw new Error(`${id} is unchanged; nothing to re-pin`);
        pin.entries[id] = { path: rel, hash, twins: twins || (before ? before.twins : []) };
        if (before && before.note) pin.entries[id].note = before.note;
        pin.repins.push({ id, from: before ? before.hash : null, to: hash, reason, date: today() });
    }

    /** Remove one entry, recording the retirement as a move to nothing (`to: null`). */
    function retireEntry(pin, id, reason) {
        const before = pin.entries[id];
        if (!before) throw new Error(`${id} is not pinned; nothing to retire`);
        delete pin.entries[id];
        pin.repins.push({ id, from: before.hash, to: null, reason, date: today() });
    }

    /**
     * Repoint one entry at `rel`, keeping its id and hash. Refused, as a logic
     * finding (exit 1), when the file at the new path hashes differently: a move
     * carries the module, never a change to it, which goes through --write.
     */
    function moveEntry(dir, pin, id, rel, reason) {
        const before = pin.entries[id];
        if (!before) throw new Error(`${id} is not pinned; use --add`);
        if (before.path === rel) throw new Error(`${id} is already at ${rel}; nothing to move`);
        const hash = hashFile(dir, rel);
        if (hash === null) throw new Error(`${rel} does not exist under ${dir}`);
        if (hash !== before.hash) {
            const err = new Error(`${id}: the logic at ${rel} (${hash.slice(0, 8)}) is not the pinned logic (${before.hash.slice(0, 8)}); a move carries a module unchanged, re-pin a changed one with --write`);
            err.exitCode = 1;
            throw err;
        }
        pin.entries[id] = Object.assign({}, before, { path: rel });
        const record = { id, from: before.hash, to: hash, path: { from: before.path, to: rel }, date: today() };
        if (reason !== undefined) record.reason = reason;
        pin.repins.push(record);
    }

    /**
     * Every difference between the pin as committed and `pin` that carries no
     * `repins` record of the right shape: a changed or added hash needs a record
     * whose `to` is the new hash, a retired id one whose `to` is null, and a
     * moved path one whose `path.to` is the new path under the unchanged hash.
     * @returns {string[]} `<id>: <what happened>` lines, empty when every change is recorded
     */
    function unrecordedChanges(committed, pin) {
        const repins = pin.repins || [];
        const out = [];
        for (const id of Object.keys(pin.entries)) {
            const before = committed.entries[id];
            const { hash, path: rel } = pin.entries[id];
            if (before && before.hash === hash) {
                if (before.path !== rel && !repins.some((r) => r.id === id && r.to === hash && r.path && r.path.to === rel)) {
                    out.push(`${id}: moved from ${before.path} to ${rel} with no --move record`);
                }
                continue;
            }
            if (!repins.some((r) => r.id === id && r.to === hash)) {
                out.push(`${id}: ${before ? 'hash changed' : 'added'} with no --write or --add record`);
            }
        }
        for (const id of Object.keys(committed.entries)) {
            if (pin.entries[id]) continue;
            if (!repins.some((r) => r.id === id && r.to === null)) out.push(`${id}: removed with no --retire record`);
        }
        return out;
    }

    /** `--init --json`: the membership as this tree and its pin (if any) read it, written nowhere. */
    function listMembers(opts) {
        const dir = opts.root;
        const pin = fs.existsSync(path.join(dir, PIN_REL)) ? readPin(dir) : null;
        const rows = memberEntries(dir, pin);
        console.log(JSON.stringify({ count: rows.length, members: rows }, null, 2));
        return 0;
    }

    /** The write paths: one entry re-pinned, added, retired or moved, or the whole membership on first use. */
    function runWrite(opts) {
        const dir = opts.root;
        const pinPath = path.join(dir, PIN_REL);
        if (opts.init) {
            if (!opts.reason) throw new Error('--reason is required for any write');
            if (fs.existsSync(pinPath)) throw new Error(`${PIN_REL} exists; --init is for a repo without one`);
            const twins = opts.twins ? JSON.parse(fs.readFileSync(opts.twins, 'utf8')) : {};
            const pin = { version: 1, entries: {}, repins: [] };
            for (const rel of members(dir, null)) pinEntry(dir, pin, moduleId(rel), rel, opts.reason, twins[moduleId(rel)] || []);
            writePin(dir, pin);
            console.log(`pinned ${Object.keys(pin.entries).length} entries to ${PIN_REL}`);
            return 0;
        }
        if (!opts.id) throw new Error('--id is required');
        if (!opts.reason && !opts.move) throw new Error('--reason is required for any write');
        const pin = readPin(dir);
        pin.repins = pin.repins || [];
        let verb;
        if (opts.add) {
            if (!opts.path) throw new Error('--add needs --path');
            if (pin.entries[opts.id]) throw new Error(`${opts.id} is already pinned; use --write`);
            pinEntry(dir, pin, opts.id, opts.path, opts.reason, opts.twins ? opts.twins.split(',') : []);
            verb = 'added';
        } else if (opts.retire) {
            retireEntry(pin, opts.id, opts.reason);
            verb = 'retired';
        } else if (opts.move) {
            if (!opts.path) throw new Error('--move needs --path');
            moveEntry(dir, pin, opts.id, opts.path, opts.reason);
            verb = 'moved';
        } else {
            if (!pin.entries[opts.id]) throw new Error(`${opts.id} is not pinned; use --add`);
            pinEntry(dir, pin, opts.id, pin.entries[opts.id].path, opts.reason);
            verb = 're-pinned';
        }
        writePin(dir, pin);
        const rec = pin.repins[pin.repins.length - 1];
        if (verb === 'moved') console.log(`moved ${opts.id}: ${rec.path.from} -> ${rec.path.to} (${rec.to.slice(0, 8)} unchanged)`);
        else if (verb === 'retired') console.log(`retired ${opts.id}: ${rec.from} -> (gone)`);
        else console.log(`${verb} ${opts.id}: ${rec.from || '(new)'} -> ${rec.to}`);
        return 0;
    }

    return {
        FIXED_CARRIER_IDS,
        idForPath,
        members,
        memberEntries,
        membershipDiff,
        retireEntry,
        moveEntry,
        unrecordedChanges,
        listMembers,
        runWrite,
    };
};
