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
 * XChain Indexer - the applied-migration checksum verdict
 *
 * One pure decision shared by the runner's immutability guard and `migrate.js --status`, so
 * the preview and the real run can never disagree about an edited applied file.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// The sha256 the runner records for a migration file's utf8 text.
function migrationChecksum(raw){
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// 'match' when the recorded hash equals the file's, 'rebaseline' when a pinned reviewed entry
// heals the recorded hash to the current one, and 'changed' for any other mismatch.
function classifyAppliedChecksum(file, recorded, current, rebaselines){
    if(recorded === current) return 'match';
    const rebase = rebaselines && Object.prototype.hasOwnProperty.call(rebaselines, file) ? rebaselines[file] : null;
    if(rebase && [].concat(rebase.from).includes(recorded) && current === rebase.to) return 'rebaseline';
    return 'changed';
}

module.exports = { migrationChecksum, classifyAppliedChecksum };
