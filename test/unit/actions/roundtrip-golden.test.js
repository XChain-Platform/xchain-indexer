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
 * SDK-encoder <-> indexer-parser byte-level field-layout contract .
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
                assert.deepStrictEqual(parsed.data, vec.parsed, `${vec.label} parser layout drifted`);
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
                assert.deepStrictEqual(parsed.data, vec.parsed, `${vec.label}: round-trip parse mismatch`);
                // Round-trip identity: what the SDK put in, the indexer reads out.
                for (const k of Object.keys(res.fields))
                    assert.strictEqual(String(parsed.data[k]), String(res.fields[k]), `${vec.label} field ${k} did not round-trip`);
            });
        }
    });
});
