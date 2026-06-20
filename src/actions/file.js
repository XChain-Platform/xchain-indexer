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
 *
 * Trailing empty fields are stripped by the encoder, so non-gated files
 * remain wire-compatible with the original 4-field FILE encoding.
 *
 ********************************************************************/

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
        this.formats[0] = 'VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH';

    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        /*****************************************************************
         * General Validations
         ****************************************************************/

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

        /*****************************************************************
         * Gated content validations (optional fields appended to format 0)
         ****************************************************************/

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
            }
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t FILE : " + data['NAME'] + ' : ' + data['TYPE'] + ' : ' + (isGated ? ('GATE=' + data['GATE_TICKER'] + ' : ') : '') + data['STATUS']);

        // Create record in files table (all versions)
        await this.indexerDb.createFile(data);

        // For valid v1 gated files, also persist the gating metadata so
        // sends of GATE_TICKER can be enforced and wallets can look up the key.
        if(isGated && status === 'valid')
            await this.indexerDb.createGatedFile(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = File;