/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const KEY = 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION';

function resolveBigIntSurfaceStripActive(registry, unarmed, network, coin, blockHeight) {
    if (network === 'regtest') return true;
    if (network !== 'mainnet' && network !== 'testnet') return false;

    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin === null || coin === undefined) return false;

    const threshold = registry.get(KEY)[coin + ':' + network];
    return threshold !== unarmed && Number.isFinite(threshold) && height >= threshold;
}

module.exports = { resolveBigIntSurfaceStripActive };
