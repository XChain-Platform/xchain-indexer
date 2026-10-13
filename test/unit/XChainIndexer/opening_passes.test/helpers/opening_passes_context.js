// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { runOpeningPasses } = require('../../../../../src/XChainIndexer/block_passes.js');

// A context whose collaborators only record, in call order, into one shared calls array.
function openingPassesContext({ vm = true, coin = 'BTC', network = 'mainnet' } = {}){
    const calls = [];
    const ctx = {
        runOpeningPasses,
        config: { COIN: coin, NETWORK: network },
        indexerDb: {},
        actions: {
            vm: vm ? { beginBlock: () => { calls.push(['vm.beginBlock']); } } : undefined,
            processTransaction: async (tx) => { calls.push(['processTransaction', tx]); }
        },
        genesis: {
            inject: async (blockIndex, blockTime) => { calls.push(['genesis.inject', blockIndex, blockTime]); }
        },
        util: {
            processContractDelegationMaterializations: async (actions, indexerDb, blockIndex) => {
                calls.push(['delegation', blockIndex]);
            }
        }
    };
    return { ctx, calls };
}

module.exports = { openingPassesContext };
