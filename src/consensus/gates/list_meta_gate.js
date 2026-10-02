'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { activeAt } = require('../gate_registry');

const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

function isListMetaActive(snapshotBlock, network){
    return activeAt(LIST_META_GATE_KEY, network, 'BTC', snapshotBlock, null);
}

function isListMetaApplyActive(coin, network, blockIndex){
    return activeAt(LIST_META_GATE_KEY, network, coin, blockIndex, null);
}

module.exports = {
    LIST_META_GATE_KEY,
    isListMetaActive,
    isListMetaApplyActive,
};
