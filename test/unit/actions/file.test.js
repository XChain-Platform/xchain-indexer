// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const File = require('../../../src/actions/file.js');

describe('File action handler @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new File(actionsCtx);
        indexer.util.resetLists();
    });

    it('creates a valid file record', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Test File', 'a memo'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('creates a valid file with no memo', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'logo.jpg', 'image/jpeg', 'Logo', ''];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects unknown format version', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 99 });
        const params = ['99', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VERSION'), `Expected VERSION error, got: ${data['STATUS']}`);
    });

    it('rejects NAME exceeding MAX_FILE_NAME_LENGTH', async function () {
        const longName = 'n'.repeat(indexer.config['MAX_FILE_NAME_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', longName, 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('NAME'), `Expected NAME length error, got: ${data['STATUS']}`);
    });

    it('rejects TYPE exceeding MAX_FILE_TYPE_LENGTH', async function () {
        const longType = 't'.repeat(indexer.config['MAX_FILE_TYPE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.bin', longType, 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TYPE'), `Expected TYPE length error, got: ${data['STATUS']}`);
    });

    it('rejects TITLE exceeding MAX_FILE_TITLE_LENGTH', async function () {
        const longTitle = 'T'.repeat(indexer.config['MAX_FILE_TITLE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', longTitle, ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TITLE'), `Expected TITLE length error, got: ${data['STATUS']}`);
    });

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    it('calls createFile on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.indexerDb.createFile.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    describe('gated content', function () {
        const SOURCE     = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const VALID_HASH = 'a'.repeat(64); // 64-char hex

        function makeGatedParams(overrides = {}) {
            return [
                '0',
                overrides.name  || 'secret.enc',
                overrides.type  || 'application/octet-stream',
                overrides.title || 'Gated File',
                overrides.memo  || '',
                overrides.gateTicker     || 'TEST',
                overrides.encMethod      !== undefined ? String(overrides.encMethod) : '1',
                overrides.keyHash        || VALID_HASH,
                // PC-29 ninth field. Omitted unless a test supplies one, so the
                // eight-field form stays exercised by every other case here.
                ...(overrides.minAmount !== undefined ? [String(overrides.minAmount)] : []),
            ];
        }

        beforeEach(function () {
            // Extra stubs needed for gated file paths
            indexer.indexerDb.createGatedFile = sinon.stub().resolves();

            // Default: token found and owned by SOURCE
            const { createTokenInfo } = require('../../fixtures/mocks');
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE })
            );
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        });

        it('valid gated file → STATUS valid, createGatedFile called', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createFile.calledOnce);
            assert.ok(indexer.indexerDb.createGatedFile.calledOnce);
        });

        /*************************************************************
         * PC-29: GATE_MIN_AMOUNT is validated STRICT.
         *
         * A present-but-invalid threshold REJECTS the FILE rather than being
         * dropped. Dropping would be the dangerous choice: a FILE is IMMUTABLE,
         * so the publisher would believe a threshold was in force while the
         * chain recorded none, forever. Replay-safe without a flag-day because
         * no conforming emitter ever produced a nine-field FILE (the SDK drops
         * unknown positional fields).
         *************************************************************/
        describe('GATE_MIN_AMOUNT (PC-29, STRICT)', function () {

            async function statusFor(minAmount, tokenOverrides) {
                if (tokenOverrides) {
                    const { createTokenInfo } = require('../../fixtures/mocks');
                    indexer.indexerDb.getTokenInfo.resolves(
                        createTokenInfo(Object.assign({ TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE }, tokenOverrides))
                    );
                }
                const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
                await handler.parse(makeGatedParams({ minAmount }), data, null);
                return data['STATUS'];
            }

            it('a valid threshold is accepted and stored', async function () {
                assert.strictEqual(await statusFor('100'), 'valid');
                assert.ok(indexer.indexerDb.createGatedFile.calledOnce);
            });

            it('an omitted threshold keeps the eight-field form valid', async function () {
                const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
                await handler.parse(makeGatedParams(), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('rejects rather than drops every malformed threshold', async function () {
                for (const bad of ['0', '0.0', '-1', '+1', '1e3', '1.', '.5', '1.2.3', 'abc', '01', '1|2'])
                    assert.strictEqual(await statusFor(bad), 'invalid: GATE_MIN_AMOUNT', 'value ' + JSON.stringify(bad));
            });

            it('rejects a threshold longer than the storage column can hold', async function () {
                // The wire bound exists so the VARCHAR(40) can never truncate a valid
                // value and make consensus validity depend on the DB's mode.
                assert.strictEqual(await statusFor('1'.repeat(41)), 'invalid: GATE_MIN_AMOUNT');
                assert.strictEqual(await statusFor('1'.repeat(40)), 'valid');
            });

            it('bounds decimal places by the gate tick divisibility (the stateful half)', async function () {
                // This is the rule the SDK deliberately cannot enforce: divisibility is
                // chain state at the FILE's block.
                assert.strictEqual(await statusFor('1.12345678', { DECIMALS: 8 }), 'valid');
                assert.strictEqual(await statusFor('1.123456789', { DECIMALS: 8 }), 'invalid: GATE_MIN_AMOUNT');
                assert.strictEqual(await statusFor('1', { DECIMALS: 0 }), 'valid');
                assert.strictEqual(await statusFor('1.5', { DECIMALS: 0 }), 'invalid: GATE_MIN_AMOUNT',
                    'an indivisible tick cannot carry a fractional threshold');
            });

            it('caps at THRESHOLD_SCALE even when the tick is more divisible', async function () {
                // Beyond THRESHOLD_SCALE the wallet's fixed-scale BigInt compare cannot
                // represent the value, so the two sides would disagree on the last digit
                // for a threshold neither considers malformed.
                const { THRESHOLD_SCALE } = require('../../../src/protocol/constants.js');
                assert.strictEqual(THRESHOLD_SCALE, 18);
                assert.strictEqual(await statusFor('1.' + '1'.repeat(18), { DECIMALS: 30 }), 'valid');
                assert.strictEqual(await statusFor('1.' + '1'.repeat(19), { DECIMALS: 30 }), 'invalid: GATE_MIN_AMOUNT',
                    'divisibility alone must not be the bound');
            });

            it('rejects a threshold on a NON-gated file (a threshold with no gate)', async function () {
                const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
                await handler.parse(['0', 'public.txt', 'text/plain', 'T', '', '', '', '', '5'], data, null);
                assert.strictEqual(data['STATUS'], 'invalid: GATE_MIN_AMOUNT',
                    'nothing would weigh a balance against, so it must not be storable');
            });

            // ── Shared vector fixture (spec section 6.5) ──────────────────────
            // The tests above are this repo's own reading of the rules. These run the
            // SAME vectors the SDK and the wallet run, from a byte-identical file, so
            // the three implementations are pinned to one another instead of to three
            // separately-written suites that agree today by coincidence. The FORMAT
            // half must match the SDK exactly; the DIVISIBILITY half is this repo's
            // alone, because it is chain state the SDK cannot see.
            describe('shared GATE_MIN_AMOUNT vectors', function () {
                const fs      = require('fs');
                const path    = require('path');
                const FIXTURE = path.join(__dirname, '../../fixtures/gate-min-amount-vectors.json');
                const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

                for (const vec of vectors.format) {
                    it(`${vec.label}: ${JSON.stringify(vec.value)} is ${vec.valid ? 'valid' : 'invalid'}`, async function () {
                        // Divisibility is set generously so a format vector can only fail
                        // on its format: an 18-decimal tick accepts every well-formed
                        // value in the set, which keeps this half honest about WHY a
                        // vector was rejected.
                        const status = await statusFor(vec.value, { DECIMALS: 18 });
                        assert.strictEqual(status, vec.valid ? 'valid' : 'invalid: GATE_MIN_AMOUNT');
                    });
                }

                for (const vec of vectors.divisibility) {
                    it(`${vec.label}: ${vec.value} at ${vec.tick_decimals}dp is ${vec.valid ? 'valid' : 'invalid'}`, async function () {
                        const status = await statusFor(vec.value, { DECIMALS: vec.tick_decimals });
                        assert.strictEqual(status, vec.valid ? 'valid' : 'invalid: GATE_MIN_AMOUNT');
                    });
                }

                // The asymmetry the shared fixture exposed, pinned from this side too:
                // utility.setActionParams trims EVERY action field on the way in (a
                // platform-wide rule long predating this one), so a whitespace-padded
                // threshold arrives here already trimmed and is accepted as the trimmed
                // value, while the SDK refuses to emit it at all. Safe direction (the
                // producer is stricter than consensus) and fork-free (every indexer runs
                // the same trim), but it does mean two byte-different FILEs can carry the
                // same threshold. Closing it would mean changing the trim for every field
                // of every action, which is a platform-wide consensus change and out of
                // scope for this batch. If that ever happens, these flip to invalid.
                for (const vec of vectors.layer_asymmetry.sdk_rejects_indexer_normalizes) {
                    it(`${vec.label}: ${JSON.stringify(vec.value)} normalizes to ${JSON.stringify(vec.normalizes_to)} and is accepted`, async function () {
                        assert.strictEqual(await statusFor(vec.value, { DECIMALS: 18 }), 'valid');
                    });
                }

                it('is byte-identical to the canonical xchain-sdk copy', function () {
                    const sibling = path.join(__dirname, '../../../../xchain-sdk/test/fixtures/gate-min-amount-vectors.json');
                    if (!fs.existsSync(sibling)) {
                        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                            throw new Error('sibling xchain-sdk fixture missing: ' + sibling);
                        return this.skip();
                    }
                    assert.ok(fs.readFileSync(sibling).equals(fs.readFileSync(FIXTURE)),
                        'the vendored copy drifted from the canonical sdk copy');
                });
            });
        });

        it('ENCRYPTION_METHOD != 1 → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ encMethod: 2 }), data, null);
            assert.ok(data['STATUS'].includes('ENCRYPTION_METHOD'));
        });

        it('KEY_HASH wrong format (not 64-char hex) → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ keyHash: 'tooshort' }), data, null);
            assert.ok(data['STATUS'].includes('KEY_HASH'));
        });

        it('KEY_HASH non-hex characters → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ keyHash: 'z'.repeat(64) }), data, null);
            assert.ok(data['STATUS'].includes('KEY_HASH'));
        });

        it('GATE_TICKER not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('GATE_TICKER'));
        });

        it('caller is not GATE_TICKER issuer → invalid', async function () {
            const { createTokenInfo } = require('../../fixtures/mocks');
            // Token owned by a different address
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER: '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp' })
            );
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('not GATE_TICKER issuer'));
        });

        it('GATE_TICKER ownership escrowed → invalid', async function () {
            indexer.indexerDb.isOwnershipEscrowed.resolves(true);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('ownership escrowed'));
        });

        it('createGatedFile NOT called on invalid gated file', async function () {
            // Missing GATE_TICKER token
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(!indexer.indexerDb.createGatedFile.called);
        });

        it('MEMO with pipe in gated file → invalid (basic MEMO check)', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ memo: 'bad|memo' }), data, null);
            assert.ok(data['STATUS'].includes('MEMO'));
        });
    });

    // ------------------------------------------------------------------
    // COMPRESSION, the tenth optional field.
    //
    // The whole point of these tests is a NEGATIVE: the field is parsed and
    // stored and can never, under any value, change a validity verdict.
    // Compression is presentational (spec §5.5); a reader that rejected a
    // malformed code while shipped indexers ignored it would fork validity
    // across the fleet.
    // ------------------------------------------------------------------
    describe('COMPRESSION field (Part B)', function () {
        const BASE = ['0', 'doc.txt', 'text/plain', 'Doc', 'memo'];
        // Local copies: the gated-content block's fixtures are scoped to it, and
        // these assertions must stand on their own.
        const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const gatedParams = () => ['0', 'secret.enc', 'application/octet-stream',
            'Gated File', '', 'TEST', '1', 'a'.repeat(64)];

        beforeEach(function () {
            // Mirror the gated-content block's stubs so a gated FILE can reach
            // 'valid': the gate ticker must resolve to a token owned by SOURCE
            // and not escrowed.
            const { createTokenInfo } = require('../../fixtures/mocks');
            indexer.indexerDb.createGatedFile = sinon.stub().resolves();
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE })
            );
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        });

        it('parses the declared codec into COMPRESSION', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
            await handler.parse([...BASE, '', '', '', '', '1'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['COMPRESSION'], '1');
        });

        it('an ABSENT field parses as null and stays valid (every historical FILE)', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
            await handler.parse(BASE, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(data['COMPRESSION'] === null || data['COMPRESSION'] === undefined);
        });

        it('NO value can invalidate the action, including hostile ones', async function () {
            // Each of these would be a fleet-forking rejection if the field
            // were validated. Every one must come back 'valid'.
            const values = [
                '1', '', '0', '2', '99', 'zstd', 'true', 'null',
                'deflate-raw', '-1', '1.0', ' 1', '1 ', 'A'.repeat(500),
                '<script>', "'; DROP TABLE files;--", ' ', '☃'
            ];
            for (const value of values) {
                const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
                await handler.parse([...BASE, '', '', '', '', value], data, null);
                assert.strictEqual(data['STATUS'], 'valid',
                    `COMPRESSION=${JSON.stringify(value)} must never affect validity`);
            }
        });

        it('the verdict is IDENTICAL with and without the field, valid or invalid', async function () {
            // Same inputs, once with the field and once without: whatever the
            // verdict is, the field must not move it. This is the property that
            // keeps a new indexer bit-compatible with an old one.
            const cases = [
                { params: BASE, expect: 'valid' },
                { params: ['0', 'a.txt', 'text/plain', 'T', 'bad|memo'], expect: 'MEMO' },
                { params: ['0', 'a.txt', 'text/plain', 'T', 'bad;memo'], expect: 'MEMO' }
            ];
            for (const c of cases) {
                const withoutData = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
                await handler.parse(c.params, withoutData, null);

                const withData = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
                await handler.parse([...c.params, '', '', '', '', '1'], withData, null);

                assert.strictEqual(withData['STATUS'], withoutData['STATUS'],
                    `verdict drifted when COMPRESSION was present (${c.expect})`);
            }
        });

        it('does not disturb the gating fields that precede it', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse([...gatedParams(), '', '1'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['COMPRESSION'], '1');
            assert.ok(String(data['GATE_TICKER']).length > 0, 'GATE_TICKER still parsed');
            assert.strictEqual(String(data['ENCRYPTION_METHOD']), '1');
        });

        it('a gated FILE with a hostile COMPRESSION value is still judged only on its gating fields', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse([...gatedParams(), '', 'not-a-codec'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
