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
 * File, broadcast, message and poll limits of src/config.js's getConfig().
 *
 * Three builders rather than one because the dispenser caps sit between them
 * in the config's key order and stay written literally in src/config.js,
 * where the SDK drift gate and the docs claims tests read them.
 ********************************************************************/

'use strict';

function applyFileAndBroadcastLimits(config){
    // MAX FILE lengths
    config['MAX_FILE_NAME_LENGTH']  = 250;
    config['MAX_FILE_TYPE_LENGTH']  = 255; // MAX MIME type length according to RFC 4288
    config['MAX_FILE_TITLE_LENGTH'] = 250;

    // BROADCAST lengths
    config['MAX_BROADCAST_MESSAGE_LENGTH']  = 250;
    config['MAX_BROADCAST_VALUE_LENGTH']    = 25;
}

function applyMessageMethods(config){
    // MESSAGE encryption methods
    config['MESSAGE_ENCRYPTION_METHODS'] = [
        1, // Elliptic Curve Integrated Encryption Scheme (ECIES)
        2, // Elliptic-curve Diffie–Hellman (ECDH)
        3, // Advanced Encryption Standard (AES)
    ];

    // SLEEP Immediate methods
    config['SLEEP_IMMEDIATE_METHODS'] = [
        -1, // Sleep actions indefinitely
         0, // Resume actions immediately
    ];
}

function applyMessageAndPollLimits(config){
    // Max MESSAGE lengths
    config['MAX_MESSAGE_LENGTH']     = 1048576; // 1 MB = 1,048,576 Characters
    config['MAX_MESSAGE_KEY_LENGTH'] = 1048576; // 1 MB = 1,048,576 Characters

    // Minimum XCHAIN deposit a VOTE v0 poll creator must escrow (anti-spam,
    // refunded on quorum / forfeited to DONATE1 on failed_quorum). '0' = no
    // deposit required (the deposit is optional until a deployment raises this).
    config['POLL_DEPOSIT_MIN'] = '0';
}

module.exports = { applyFileAndBroadcastLimits, applyMessageMethods, applyMessageAndPollLimits };
