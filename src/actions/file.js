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
 *   xchain-documentation/protocol/TOKEN_GATED_CONTENT.md
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
 * - GATE_MIN_AMOUNT   - (optional, PC-29) minimum GATE_TICKER balance a recipient
 *                       must hold to be given the key. Absent/empty = no threshold.
 * - COMPRESSION       - (optional) payload compression codec. Absent/empty = raw
 *                       (every historical FILE); '1' = deflate-raw.
 *                       PARSE-AND-STORE ONLY, NEVER VALIDATED (see below).
 *
 * Trailing empty fields are stripped by the encoder, so non-gated files
 * remain wire-compatible with the original 4-field FILE encoding.
 *
 ********************************************************************/

// PC-29: wire bound on GATE_MIN_AMOUNT (matches the SDK validator and the
// gated_files.gate_min_amount column width), and the fixed comparison scale the
// wallet uses. Vendored byte-identical from xchain-documentation/protocol/constants.js.
const { THRESHOLD_SCALE } = require('../protocol/constants.js');
const GATE_MIN_AMOUNT_MAX_LENGTH = 40;

class File {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        // Optional NINTH field, the unlock threshold: the eight-field form is
        // byte-identical, so historical FILEs replay unchanged.
        //
        // Optional TENTH field, COMPRESSION, deliberately absent from every
        // validation below because compression is PRESENTATIONAL, not consensus
        // (spec §5.5): FILE validity never inspects rawData content, so parsing
        // this field changes nothing about what is valid. Validating it would let
        // an indexer that rejects a malformed value fork VALIDITY against
        // neighbours that ignore unknown trailing fields (as shipped indexers do),
        // so unknown/invalid codes must stay inert here and degrade to serve-raw
        // at the reader.
        //
        // There is also deliberately no gated_files/files column for it: serve
        // paths derive COMPRESSION from the stored ACTION STRING at serve time
        // (spec §5.1), not a parsed-at-ingest column, so a FILE compressed before
        // an indexer upgrade is never stored marker-less and served as garbage
        // forever. The action string is already preserved verbatim.
        this.formats[0] = 'VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION';

    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // General Validations

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify NAME is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['NAME']).length > this.config['MAX_FILE_NAME_LENGTH'])
            error = 'invalid: NAME (length)';

        // Verify TYPE is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['TYPE']).length > this.config['MAX_FILE_TYPE_LENGTH'])
            error = 'invalid: TYPE (length)';

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

        // Gated content validations (optional fields appended to format 0)

        let isGated = (!this.util.isNull(data['GATE_TICKER']) && String(data['GATE_TICKER']).length > 0);

        if(!error && isGated){
            // ENCRYPTION_METHOD must be 1 (AES-256-GCM) in v1
            if(Number(data['ENCRYPTION_METHOD']) !== 1)
                error = 'invalid: ENCRYPTION_METHOD (must be 1)';

            // KEY_HASH must be 64-char hex
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

                // GATE_MIN_AMOUNT is validated STRICT: a present but invalid
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
                    // Format rules, byte-for-byte the SDK's stateless set (spec §5.2).
                    if(raw.length > GATE_MIN_AMOUNT_MAX_LENGTH)
                        error = 'invalid: GATE_MIN_AMOUNT';
                    else if(!/^\d+(\.\d+)?$/.test(raw))
                        error = 'invalid: GATE_MIN_AMOUNT';
                    else if(/^0\d/.test(raw))
                        error = 'invalid: GATE_MIN_AMOUNT';
                    else if(!/[1-9]/.test(raw))
                        error = 'invalid: GATE_MIN_AMOUNT';   // every zero spelling
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
            }
        }

        // A threshold with no gate is meaningless and must not be storable: it would
        // sit in gated_files with no gate_ticker to weigh a balance against. Rejected
        // rather than ignored, for the same immutability reason as above.
        if(!error && !isGated && !this.util.isNull(data['GATE_MIN_AMOUNT']) &&
           String(data['GATE_MIN_AMOUNT']).length > 0)
            error = 'invalid: GATE_MIN_AMOUNT';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t FILE : " + data['NAME'] + ' : ' + data['TYPE'] + ' : ' + (isGated ? ('GATE=' + data['GATE_TICKER'] + ' : ') : '') + data['STATUS']);

        // Persisted for every version; gated_files (below) is written only for valid v1 gated files
        await this.indexerDb.createFile(data);

        // For valid v1 gated files, also persist the gating metadata so
        // sends of GATE_TICKER can be enforced and wallets can look up the key.
        if(isGated && status === 'valid')
            await this.indexerDb.createGatedFile(data);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);

    }
}

module.exports = File;