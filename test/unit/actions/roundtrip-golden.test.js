'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * SDK-encoder <-> indexer-parser byte-level field-layout contract.
 *
 * On the wire an ACTION is a pipe-delimited `ACTION|VERSION|FIELD...` string.
 * The indexer decodes it exactly as processTransaction does: split on '|',
 * shift the ACTION, inject the legacy VERSION default for bare ISSUE/MINT/SEND,
 * read the format version, then map the positional params through the handler's
 * `formats[version]` template (setActionParams). The xchain-sdk encoder is the
 * producer of that same string. Nothing else in the manifest conformance system
 * asserts the two agree on every field's byte position, so a field inserted on
 * one side only (the 2026-05 ORDER/SWAP/DISPENSER ownership flags, SWEEP escrow
 * flags, STAKE/UNSTAKE/DELEGATE capability model) would mis-parse silently.
 *
 * This suite pins the PARSER half against committed golden wire strings (runs
 * in the unit tier, no sibling checkout needed). When a sibling xchain-sdk
 * checkout is present it also drives the live SDK encoder to confirm it still
 * serializes to the exact golden wire (the full round-trip), and asserts the
 * two vendored golden copies are byte-identical.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// Utility loads config in its constructor; set coin/network first.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility     = require('../../../src/utility.js');
const ACTIONS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'actions');

const FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'action-roundtrip-golden.json');
const GOLDEN       = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// Load every action handler's declared formats with a stub context (no DB),
// exactly the pattern used by actionFormats.test.js.
function loadHandlerFormats() {
    const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };
    const out = {};
    for (const file of fs.readdirSync(ACTIONS_DIR)) {
        if (!file.endsWith('.js') || file === 'README.md') continue;
        let Handler, inst;
        try { Handler = require(path.join(ACTIONS_DIR, file)); } catch (_) { continue; }
        if (typeof Handler !== 'function') continue;
        try { inst = new Handler(STUB); } catch (_) { continue; }
        if (inst && inst.formats && typeof inst.formats === 'object' && Object.keys(inst.formats).length)
            out[file.replace(/\.js$/, '')] = inst.formats;
    }
    return out;
}

const util    = new Utility();
const FORMATS = loadHandlerFormats();

// ── Fields added to an action's canonical field map AFTER this golden was cut ──────────
//
// WHY A MAP LIKE THIS EXISTS AT ALL. setActionParams positions the wire params through the
// format template for THIS version, then walks getFormatFieldList(formats) - the UNION of
// every version's field names - and writes null for each member the version does not carry.
// So a field introduced by a NEW format version appears, as null, in the parse output of
// every OLD version too. That is not drift: it is how the parser has always kept the stored
// object free of `undefined`, and the golden's own vectors record the last such event (the
// format-6 controller fields CONTROLLER, ACTION_CLASS, COOLDOWN_BLOCKS and UNBIND sit as
// nulls inside the v0 and v1 maps below).
//
// ISSUE FORMAT 7 (the token-bridge opt-in) is the next one, and it was checked rather than
// assumed: HEAD's issue.js and this build's were both driven over a real v0 wire, a real v1
// wire and a legacy bare ISSUE, and every pre-existing key came back byte-identical in value
// with nothing removed - only BRIDGE_CHAINS, MIN_DEPTH and LOCK_BRIDGE added, each null. A
// v0 or v1 ISSUE therefore parses and hashes exactly as it did (the three names reach no
// guard: every format-7 refusal is behind `format === 7` and TOKEN_BRIDGE_ACTIVATION, and
// the two fieldList['LOCK'] loops skip a null value), so this is a union widening and not a
// fork, and the golden vectors stay as they are.
//
// THE ADDITION IS SPELLED OUT BY HAND, never read back from the handler under test: an
// expectation derived from the code it checks would pass no matter what the code did. Every
// other key still has to match the vector exactly, and each key here has to arrive with
// exactly the value written here. The two vendored golden copies (this repo and xchain-sdk)
// stay byte-identical because neither is touched; when they are next re-cut together with
// format 7 present, the entry below collapses to an empty object.
const POST_GOLDEN_UNION_FIELDS = Object.freeze({
    ISSUE: Object.freeze({ BRIDGE_CHAINS: null, MIN_DEPTH: null, LOCK_BRIDGE: null }),
});

// The field map a vector's wire must parse into: the golden's own map plus the union fields
// added after it was cut.
function expectedParsed(vec) {
    return Object.assign({}, vec.parsed, POST_GOLDEN_UNION_FIELDS[vec.action] || {});
}

// Mirror XChainIndexer.processTransaction's parse path for a single wire string.
function indexerParse(wire) {
    const fmts = FORMATS[String(wire).split('|')[0].toLowerCase()];
    let params = String(wire).split('|').map((v) => String(v).trim());
    let action = String(params.shift()).toUpperCase();
    if (['ISSUE', 'MINT', 'SEND'].includes(action) && util.isLegacyActionFormat(params))
        params.splice(0, 0, 0);
    let format = util.getFormatVersion(params[0]);
    let data   = util.setActionParams({}, params, fmts, format);
    return { action, format, data };
}

// Resolve a sibling xchain-sdk checkout (XCHAIN_SDK_PATH first, then the
// monorepo sibling layout). Returns null when absent so the unit tier degrades
// to the parser-half pin.
function resolveSdkRoot() {
    const candidates = [
        process.env.XCHAIN_SDK_PATH,
        path.join(__dirname, '..', '..', '..', '..', 'xchain-sdk'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'actions.js')))
            return root;
    }
    return null;
}

describe('Action round-trip golden – indexer parser byte-layout contract', function () {

    it('loads a representative set of golden vectors', function () {
        assert.ok(Array.isArray(GOLDEN.vectors));
        assert.ok(GOLDEN.vectors.length >= 15, 'expected many golden vectors');
    });

    describe('indexer parser reads each golden wire into the exact field layout', function () {
        for (const vec of GOLDEN.vectors) {
            it(`${vec.label}: parse(wire) -> canonical field map`, function () {
                const parsed = indexerParse(vec.wire);
                assert.strictEqual(parsed.action, vec.action, `${vec.label} action`);
                assert.strictEqual(String(parsed.format), String(vec.version), `${vec.label} format version`);
                assert.deepStrictEqual(parsed.data, expectedParsed(vec), `${vec.label} parser layout drifted`);
            });
        }
    });

    describe('full round-trip against a live SDK encoder (when sibling present)', function () {
        const sdkRoot = resolveSdkRoot();
        let makeActions = null;

        before(function () {
            if (!sdkRoot) {
                this.skip(); // unit tier: no sibling sdk checkout
                return;
            }
            const sdkConfig = require(path.join(sdkRoot, 'src', 'config.js'));
            const SdkUtil   = require(path.join(sdkRoot, 'src', 'utility.js'));
            const Actions   = require(path.join(sdkRoot, 'src', 'actions.js'));
            makeActions = () => new Actions({ config: sdkConfig.getConfig(), util: new SdkUtil() });
        });

        it('the two vendored golden copies are byte-identical', function () {
            if (!sdkRoot) this.skip();
            const sibling = fs.readFileSync(path.join(sdkRoot, 'test', 'fixtures', 'action-roundtrip-golden.json'), 'utf8');
            assert.strictEqual(sibling, fs.readFileSync(FIXTURE_PATH, 'utf8'), 'vendored golden copies drifted');
        });

        for (const vec of GOLDEN.vectors) {
            it(`${vec.label}: SDK serializes input to the golden wire, which parses back identically`, function () {
                if (!makeActions) this.skip();
                const res = makeActions().createAction({ action: vec.action, params: vec.input });
                assert.strictEqual(res.actionString, vec.wire, `${vec.label}: SDK encoder wire drifted from golden`);
                const parsed = indexerParse(res.actionString);
                assert.deepStrictEqual(parsed.data, expectedParsed(vec), `${vec.label}: round-trip parse mismatch`);
                // Round-trip identity: what the SDK put in, the indexer reads out.
                for (const k of Object.keys(res.fields))
                    assert.strictEqual(String(parsed.data[k]), String(res.fields[k]), `${vec.label} field ${k} did not round-trip`);
            });
        }
    });
});

// ── Pre-format-7 replay pin ────────────────────────────────────────────────────────────
//
// The map above says a v0 or v1 ISSUE gained three null keys and nothing else. This block
// is what makes that a claim the suite can lose rather than a comment: the two maps are the
// PRE-CHANGE golden, copied verbatim out of the commit before ISSUE format 7 existed
// (`git show HEAD:test/fixtures/action-roundtrip-golden.json` at 2026-09-12), and they are
// frozen here so no later edit to the fixture can quietly re-baseline them.
//
// What is asserted is the consensus-relevant half: every field a pre-format-7 node produced
// for these two wires, this build produces byte-identically, and the ONLY difference in the
// whole object is the three named additions, each null. A format-7 definition that reused a
// field position, renamed one, or made a bridge field carry a value on a v0 parse fails here
// even if the fixture were re-cut to match it.
const PRE_FORMAT7_ISSUE = Object.freeze([
    {
        label: 'ISSUE full v0',
        wire:  'ISSUE|0|GOLDTOKEN|21000000|1000|8|gold token|1000|||1|||||||||||||||hello',
        parsed: Object.freeze({
            VERSION: '0', TICK: 'GOLDTOKEN', MAX_SUPPLY: '21000000', MAX_MINT: '1000',
            DECIMALS: '8', DESCRIPTION: 'gold token', MINT_SUPPLY: '1000', TRANSFER: null,
            TRANSFER_SUPPLY: null, LOCK_MAX_SUPPLY: '1', LOCK_MAX_MINT: null,
            LOCK_DESCRIPTION: null, LOCK_SLEEP: null, LOCK_CALLBACK: null, CALLBACK_BLOCK: null,
            CALLBACK_TICK: null, CALLBACK_AMOUNT: null, ALLOW_LIST: null, BLOCK_LIST: null,
            MINT_ADDRESS_MAX: null, MINT_START_BLOCK: null, MINT_STOP_BLOCK: null,
            LOCK_MINT: null, LOCK_MINT_SUPPLY: null, MEMO: 'hello', CONTROLLER: null,
            ACTION_CLASS: null, COOLDOWN_BLOCKS: null, UNBIND: null,
        }),
    },
    {
        label: 'ISSUE brief v1',
        wire:  'ISSUE|1|BRRR|brrr desc|m',
        parsed: Object.freeze({
            VERSION: '1', TICK: 'BRRR', DESCRIPTION: 'brrr desc', MEMO: 'm', MAX_SUPPLY: null,
            MAX_MINT: null, DECIMALS: null, MINT_SUPPLY: null, TRANSFER: null,
            TRANSFER_SUPPLY: null, LOCK_MAX_SUPPLY: null, LOCK_MAX_MINT: null,
            LOCK_DESCRIPTION: null, LOCK_SLEEP: null, LOCK_CALLBACK: null, CALLBACK_BLOCK: null,
            CALLBACK_TICK: null, CALLBACK_AMOUNT: null, ALLOW_LIST: null, BLOCK_LIST: null,
            MINT_ADDRESS_MAX: null, MINT_START_BLOCK: null, MINT_STOP_BLOCK: null,
            LOCK_MINT: null, LOCK_MINT_SUPPLY: null, CONTROLLER: null, ACTION_CLASS: null,
            COOLDOWN_BLOCKS: null, UNBIND: null,
        }),
    },
]);

// The three names ISSUE format 7 introduced, and the only keys this build may add to a
// pre-format-7 ISSUE parse.
const FORMAT7_ADDED_FIELDS = Object.freeze(['BRIDGE_CHAINS', 'MIN_DEPTH', 'LOCK_BRIDGE']);

describe('ISSUE v0/v1 parse is byte-identical to the pre-format-7 build @regression @consensus', function () {

    for (const vec of PRE_FORMAT7_ISSUE) {

        it(`${vec.label}: every pre-format-7 field parses to the same value`, function () {
            const parsed = indexerParse(vec.wire).data;
            for (const [field, value] of Object.entries(vec.parsed))
                assert.strictEqual(parsed[field], value,
                    `${vec.label}: field ${field} moved from ${JSON.stringify(value)} to ${JSON.stringify(parsed[field])}`);
        });

        it(`${vec.label}: adds exactly the three format-7 names, each null`, function () {
            const parsed = indexerParse(vec.wire).data;
            const added  = Object.keys(parsed).filter((k) => !(k in vec.parsed));
            assert.deepStrictEqual(added.slice().sort(), FORMAT7_ADDED_FIELDS.slice().sort(),
                `${vec.label}: unexpected additions to the canonical field map`);
            for (const field of added)
                assert.strictEqual(parsed[field], null, `${vec.label}: ${field} must parse as null on a v${parsed.VERSION} wire`);
        });

        it(`${vec.label}: drops no field the pre-format-7 build produced`, function () {
            const parsed = indexerParse(vec.wire).data;
            const missing = Object.keys(vec.parsed).filter((k) => !(k in parsed));
            assert.deepStrictEqual(missing, [], `${vec.label}: fields disappeared from the canonical map`);
        });
    }
});
