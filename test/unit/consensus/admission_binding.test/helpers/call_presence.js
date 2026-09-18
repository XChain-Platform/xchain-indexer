/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The harness of the admission-binding call-presence part: the pinned floor and coverage
 * statements, a stubbed hub connection carrying the real db mixin reads, and the floor
 * readings an armed block measures against.
 *
 ********************************************************************/

'use strict';

const sinon = require('sinon');

const { sleep } = require('../../../../helpers/wait.js');
const { NETWORK } = require('./arms.js');

const { HUB_SYNC_WATERMARK_GRACE_S } = require('../../../../../src/hub/hub_db_sync.js');
const GRACE = HUB_SYNC_WATERMARK_GRACE_S.call;
const NOW_S = () => Math.floor(Date.now() / 1000);
const FLOOR_SQL = "SELECT param_value FROM configs WHERE coin = ? AND network = ? AND module = ? AND param_name = ?";
const COVERAGE_SQL = "SELECT MAX(effective_time) AS ts, UNIX_TIMESTAMP() AS hub_now " +
                     "FROM cross_chain_calls WHERE status = 'finalized' AND (target_chain = ? OR source_chain = ?)";

// A harness in the shape the existing directCallPresence suite uses, plus the config
// and the activation reader the height form reaches.
function ctx(h, opts) {
    const o = opts || {};
    const captured = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        captured.push({ sql, args });
        if (o.fail) throw new Error(o.fail);
        return typeof o.rows === 'function' ? o.rows(sql, args) : (o.rows || []);
    });
    const self = {
        // Real db mixin reads bound over the stubbed connection, so the SQL and argument
        // assertions further down still read what the shipped methods issue.
        hubDb: o.noHubDb ? null : Object.assign({ doQuery, doQueryStrict: doQuery }, {
            getHubCrossChainCallCoverage(chain){
                return require('../../../../../src/db/cross_chain').getHubCrossChainCallCoverage.call(this, chain);
            },
            getHubConfigParam(coin, network, module, paramName){
                return require('../../../../../src/db/misc').getHubConfigParam.call(this, coin, network, module, paramName);
            }
        }),
        config: o.noConfig ? undefined : { COIN: o.coin || 'BTC', NETWORK: NETWORK },
        callPresenceTimeoutMs: o.timeoutMs != null ? o.timeoutMs : 40,
        directCallGraceS: o.graceS,
        util: { sleep: (ms) => sleep(ms), throwError: (msg) => { throw new Error(msg); } },
        mirrorAdmissionActiveAt: h.Indexer.prototype.mirrorAdmissionActiveAt,
        captured
    };
    return self;
}
const run      = (h, self, bt, B) => h.Indexer.prototype.waitForDirectCallPresence.call(self, bt, B);
const clearsAt = (h, self, bt, B) => h.Indexer.prototype.directCallBarrierClearsAt.call(self, bt, B);
const floorRow = (v) => [{ param_value: v }];

// What an armed block at height B measures a floor against, the same in every arm and every block.
function floorTargets(B) {
    // The margin is a frozen constant of the twin, the same in every arm.
    const target = B - require('../../../../../src/consensus/gates/mirror_admission_gate.js').admitMarginBlocks('cross_chain_calls');

    // A persisted floor is canonical digits, so it is never negative: at B=0 the
    // target is below genesis, every real floor covers it, and the only NOT-covered
    // readings are the unusable ones (the Number(null) trap case below).
    const covering = String(Math.max(target, 0));
    const short    = (target >= 1) ? String(target - 1) : null;
    return { target, covering, short };
}

module.exports = { GRACE, NOW_S, FLOOR_SQL, COVERAGE_SQL, ctx, run, clearsAt, floorRow, floorTargets };
