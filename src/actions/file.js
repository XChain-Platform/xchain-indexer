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
 *
 *  XChain Platform Action - FILE
 *
 * This action uploads a file including file metadata. Supports
 * token-gated cryptographic publishing (encrypted file bytes readable only
 * by holders of GATE_TICKER) via the optional gating fields appended to
 * format 0. See
 *   xchain-documentation/protocol/token-gated-content.md
 *
 * PARAMS:
 * - VERSION           - Format Version (always 0; new fields are appended)
 * - NAME              - Name of the file
 * - TYPE              - MIME Type of the file
 * - TITLE             - Title of the file
 * - MEMO              - An optional memo to include
 * - GATE_TICKER       - (optional) Token ticker gating this file. Empty = public.
 * - ENCRYPTION_METHOD - (optional) 1 = AES-256-GCM. Required when GATE_TICKER set.
 * - KEY_HASH          - (optional) hex sha256(K), 64 chars. Required when GATE_TICKER set.
 * - GATE_MIN_AMOUNT   - (optional) minimum GATE_TICKER balance a recipient
 *                       must hold to be given the key. Absent/empty = no threshold.
 * - COMPRESSION       - (optional) payload compression codec. Absent/empty = raw
 *                       (every historical FILE); '1' = deflate-raw.
 *                       PARSE-AND-STORE ONLY, NEVER VALIDATED (see below).
 *
 * Trailing empty fields are stripped by the encoder, so non-gated files
 * remain wire-compatible with the original 4-field FILE encoding.
 *
 ********************************************************************/

// Wire bound on GATE_MIN_AMOUNT (matches the SDK validator and the
// gated_files.gate_min_amount column width), and the fixed comparison scale the
// wallet uses. Vendored byte-identical from xchain-documentation/protocol/constants.js.
const {
    THRESHOLD_SCALE,
    MULTIPART_FILE_MAX_PARTS,
    MULTIPART_FILE_MAX_BYTES,
} = require('../protocol/constants.js');
const { getLogger } = require('../observability/index.js');
const { fitsUtf8mb3 } = require('../db/utf8mb3.js');
const {
    MANIFEST_FORMAT,
    PART_FORMAT,
    multipartRoute,
    duplicateManifestVerdict,
} = require('./file_multipart_route.js');
const { validateMultipartFields, checkMultipartBatch } = require('./file_multipart_validate.js');
const { partDigestOf, sanitizeMultipartRow } = require('./file_multipart_store.js');
const { completeMultipart } = require('./file_multipart.js');
const GATE_MIN_AMOUNT_MAX_LENGTH = 40;
const MULTIPART_LIMITS = {
    maxParts: MULTIPART_FILE_MAX_PARTS,
    maxBytes: MULTIPART_FILE_MAX_BYTES,
};

class File {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        // Optional NINTH field, the unlock threshold. The eight-field form is
        // byte-identical, so historical FILEs replay unchanged.
        //
        // Optional TENTH field, COMPRESSION, deliberately absent from every
        // validation below because compression is PRESENTATIONAL, not consensus
        // state: FILE validity never inspects rawData content, so an indexer
        // that has never heard of this field produces identical verdicts and
        // identical state, and parsing it changes nothing about what is valid.
        // COMPRESSION therefore MUST NOT be validated: an indexer that rejected a
        // malformed value would fork VALIDITY against neighbours that ignore unknown
        // trailing fields (as shipped indexers do), which is the one consensus break
        // this field is defined to be incapable of causing. Unknown or invalid codes
        // stay inert here and degrade to serve-raw at the reader.
        //
        // There is also deliberately no gated_files/files column for it: serve
        // paths derive COMPRESSION from the stored ACTION STRING at serve time
        // rather than from a parsed-at-ingest column, so a FILE compressed before
        // an indexer upgrade is never stored marker-less and served as deflated
        // garbage forever, even after the upgrade. The action string is already
        // preserved verbatim, so a column would only invite the parsed-at-ingest trap.
        this.formats[0] = 'VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION';
        this.formats[1] = MANIFEST_FORMAT;
        this.formats[2] = PART_FORMAT;

    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        let format = data['FORMAT'];
        let enabled = false;
        if(format === 1 || format === 2)
            enabled = await this.actions.protocolChanges.isEnabled('FILE_MULTIPART', data['BLOCK_INDEX']);
        const routed = multipartRoute(format, enabled, error);
        error = routed.error;
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);
        if(routed.route === 'part')
            return this.parsePart(data, error);
        return this.parseFile(data, error, routed.route === 'manifest');
    }

    async parsePart(data, error){
        error = await this.validateSource(data, error);
        error = this.validateMultipart(data, error);
        const status = error || 'valid';
        data['STATUS'] = status;
        const digest = partDigestOf(data['RAW_DATA']);
        const stored = Object.assign({}, data, sanitizeMultipartRow(data), {
            BYTE_LENGTH: digest.byteLength,
            PART_DIGEST: digest.partDigest,
        });
        getLogger().info("\t FILE PART : " + stored['FILE_HASH'] + ' : ' + status);
        await this.indexerDb.createPart(stored);
        this.util.addAddressTicker(data['SOURCE']);
        if(status === 'valid')
            await completeMultipart(this.indexerDb, stored);
    }

    async parseFile(data, error, isManifest){
        error = await this.validateSource(data, error);
        if(isManifest)
            error = await this.validateManifest(data, error);
        error = this.validateLegacyFields(data, error);
        let isGated = (!this.util.isNull(data['GATE_TICKER']) && String(data['GATE_TICKER']).length > 0);
        error = await this.validateGatedContent(data, isGated, error);
        if(!error && !isGated && !this.util.isNull(data['GATE_MIN_AMOUNT']) &&
           String(data['GATE_MIN_AMOUNT']).length > 0)
            error = 'invalid: GATE_MIN_AMOUNT';
        let status = error || 'valid';
        data['STATUS'] = status;
        getLogger().info("\t FILE : " + data['NAME'] + ' : ' + data['TYPE'] + ' : ' + (isGated ? ('GATE=' + data['GATE_TICKER'] + ' : ') : '') + data['STATUS']);
        await this.indexerDb.createFile(data);
        if(isGated && status === 'valid')
            await this.indexerDb.createGatedFile(data);
        this.util.addAddressTicker(data['SOURCE']);
        await this.mapper.createMappings(data);
        if(isManifest){
            const stored = Object.assign({}, data, sanitizeMultipartRow(data));
            await this.indexerDb.createManifest(stored);
            if(status === 'valid')
                await completeMultipart(this.indexerDb, stored);
        }
    }

    async validateManifest(data, error){
        error = this.validateMultipart(data, error);
        if(!error){
            const group = await this.indexerDb.getGroup(data['SOURCE'], data['FILE_HASH']);
            error = duplicateManifestVerdict(error, group.manifest, data['FILE_HASH']);
        }
        return error;
    }

    validateMultipart(data, error){
        error = validateMultipartFields(data, error, MULTIPART_LIMITS).error;
        return checkMultipartBatch(data, error);
    }

    async validateSource(data, error){
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';
        return error;
    }

    // General Validations
    async validateFields(data, error){
        error = await this.validateSource(data, error);
        return this.validateLegacyFields(data, error);
    }

    validateLegacyFields(data, error){

        // Verify NAME is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['NAME']).length > this.config['MAX_FILE_NAME_LENGTH'])
            error = 'invalid: NAME (length)';

        // Verify TYPE is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['TYPE']).length > this.config['MAX_FILE_TYPE_LENGTH'])
            error = 'invalid: TYPE (length)';

        // Verify TYPE has no character above U+FFFF. index_mime_types is utf8mb3, so
        // such a TYPE would throw errno 1267 and halt the indexer. createFile still
        // runs for an invalid FILE, so the unstorable TYPE is blanked (stored as NULL)
        // whatever error came first; the verdict itself never depends on the blanking.
        if(!fitsUtf8mb3(data['TYPE'])){
            data['TYPE'] = '';
            if(!error)
                error = 'invalid: TYPE (format)';
        }

        // Verify TITLE is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['TITLE']).length > this.config['MAX_FILE_TITLE_LENGTH'])
            error = 'invalid: TITLE (length)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        return error;
    }

    // Gated content validations (optional fields appended to format 0)
    async validateGatedContent(data, isGated, error){

        // Validate the gated-content fields, but only when this FILE is actually gated
        if(!error && isGated){
            // ENCRYPTION_METHOD 1 (AES-256-GCM) is the only defined method.
            if(Number(data['ENCRYPTION_METHOD']) !== 1)
                error = 'invalid: ENCRYPTION_METHOD (must be 1)';

            // KEY_HASH must be 64-char hex. The /i is consensus as shipped: this
            // clause has always taken either case, and db.js records the lowercase
            // form, so tightening it would retroactively invalidate FILEs the live
            // chain accepted. It moves only behind a flag day.
            if(!error && !/^[0-9a-f]{64}$/i.test(String(data['KEY_HASH'] || '')))
                error = 'invalid: KEY_HASH (format)';

            // Only the issuer of GATE_TICKER may publish gated files for it.
            // Prevents third parties from gating spam content to popular tickers.
            if(!error){
                let tokenInfo = await this.indexerDb.getTokenInfo(data['GATE_TICKER'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(!tokenInfo)
                    error = 'invalid: GATE_TICKER (unknown)';
                else if(tokenInfo['OWNER'] !== data['SOURCE'])
                    error = 'invalid: SOURCE (not GATE_TICKER issuer)';
                else if(await this.indexerDb.isOwnershipEscrowed(data['GATE_TICKER']))
                    error = 'invalid: GATE_TICKER (ownership escrowed)';

                error = this.validateGateMinAmount(data, tokenInfo, error);
            }
        }

        return error;
    }

    // Threshold rules for a gated FILE's GATE_MIN_AMOUNT field
    validateGateMinAmount(data, tokenInfo, error){

        // GATE_MIN_AMOUNT is validated STRICT. A present but invalid
        // threshold REJECTS the FILE rather than being dropped, since a
        // FILE is immutable and dropping would let the publisher believe
        // a threshold was in force when the chain recorded none. This is
        // replay-safe without a flag-day because the SDK drops unknown
        // positional fields, so no conforming emitter has ever produced a
        // nine-field FILE. The gate-tick-existence clause the spec leaves
        // open is moot here: an unknown GATE_TICKER already rejects the
        // whole FILE above.
        if(!error && !this.util.isNull(data['GATE_MIN_AMOUNT']) &&
           String(data['GATE_MIN_AMOUNT']).length > 0){
            let raw = String(data['GATE_MIN_AMOUNT']);
            // Format rules, byte-for-byte the SDK's stateless validation set.
            // Length first, so a pathological input never reaches the regexes below.
            if(raw.length > GATE_MIN_AMOUNT_MAX_LENGTH)
                error = 'invalid: GATE_MIN_AMOUNT';
            else if(!/^\d+(\.\d+)?$/.test(raw))
                error = 'invalid: GATE_MIN_AMOUNT';
            // No leading zeros: '007' and '7' must not be two spellings of one threshold.
            else if(/^0\d/.test(raw))
                error = 'invalid: GATE_MIN_AMOUNT';
            // A zero threshold is not a gate: the field exists to require a nonzero balance.
            else if(!/[1-9]/.test(raw))
                error = 'invalid: GATE_MIN_AMOUNT';   // every zero spelling
            // Verify GATE_MIN_AMOUNT does not use more decimal places than the tick (or the fixed threshold scale) allows
            if(!error){
                // Divisibility: the STATE-dependent half the SDK cannot do.
                // Bounded at min(tick divisibility, THRESHOLD_SCALE) because a
                // threshold with more than THRESHOLD_SCALE decimals is
                // unrepresentable in the wallet's fixed-scale BigInt compare,
                // so the two sides would disagree on the last digit for a value
                // neither considers malformed.
                let dot      = raw.indexOf('.');
                let places   = (dot === -1) ? 0 : (raw.length - dot - 1);
                let tickDec  = Number(tokenInfo['DECIMALS']);
                if(!Number.isFinite(tickDec)) tickDec = 0;
                let maxPlaces = Math.min(tickDec, THRESHOLD_SCALE);
                if(places > maxPlaces)
                    error = 'invalid: GATE_MIN_AMOUNT';
            }
        }

        return error;
    }
}

module.exports = File;
