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
 * XChain Platform - list share settle halt vocabulary and pinned constants.
 *
 ********************************************************************/

'use strict';

class ListShareHaltError extends Error {
    constructor(reason, snapshotId, detail) {
        const suffix = detail ? ': ' + detail : '';
        super('List share halt ' + reason + ' for snapshot ' + snapshotId + suffix);
        this.name = 'ListShareHaltError';
        this.reason = reason;
        this.snapshot_id = snapshotId;
    }
}

const LIST_SHARE_HALT_REASON = Object.freeze({
    SCREEN:          'SCREEN',
    SEQ_GAP:         'SEQ_GAP',
    NO_HEIGHT:       'NO_HEIGHT',
    QUORUM:          'QUORUM',
    SNAPSHOT_ABSENT: 'SNAPSHOT_ABSENT',
    MEMBERS_HASH:    'MEMBERS_HASH',
    DELTA:           'DELTA',
    LEG:             'LEG',
    NO_OWNER:        'NO_OWNER',
    META_HASH:       'META_HASH',
});

const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

const LIST_SHARE_LEG_FORMAT = Object.freeze({
    CREATE:          '0',
    EDIT:            '1',
    CREATE_WITH_META:'4',
    META:            '5',
});

// 11 prefix characters plus 48 snapshot-id characters fit within the 64-character
// unique prefix of index_transactions.hash.
const LIST_SHARE_TX_PREFIX = 'LIST_SHARE-';

// Consensus-visible synthetic transaction vout ordinals, pinned for every node.
const LIST_SHARE_LEG_ORDINAL = Object.freeze({
    CREATE_OR_REMOVE: 0,
    ADD:              1,
    META:             2,
});

module.exports = {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
    LIST_META_GATE_KEY,
    LIST_SHARE_LEG_FORMAT,
    LIST_SHARE_TX_PREFIX,
    LIST_SHARE_LEG_ORDINAL,
};
