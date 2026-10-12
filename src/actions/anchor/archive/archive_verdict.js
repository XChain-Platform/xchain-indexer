// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { getLogger } = require('../../../observability/index.js');
const diag = require('../diagnostic_events.js');

async function reportArchiveFailure(handler, failure, sectionScoped) {
    getLogger().warn(failure.logLine);
    diag.noteAnchorFailed(failure.event);

    const actionIndex = Number(failure.actionIndex);
    if (sectionScoped) {
        if (typeof handler.indexerDb.setAnchorArchiveRowStatus !== 'function') {
            throw new Error('Missing handler.indexerDb.setAnchorArchiveRowStatus');
        }
        return handler.indexerDb.setAnchorArchiveRowStatus(actionIndex, 'invalid_archive');
    }
    return handler.indexerDb.setAnchorArchiveStatus(actionIndex, 'invalid_archive');
}

module.exports = { reportArchiveFailure };
