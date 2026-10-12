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
 **********************************************************************
 * test/unit/hub/table_lifecycle.test.js
 *
 * Replication-class pins for the canonical table-lifecycle registry.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');
const L = require('../../../src/hub/table_lifecycle');

describe('table lifecycle: push_generations replication class', () => {
  it('is local (per-node reorg fence counter, never snapshot-shipped)', () => {
    const e = L.entry('push_generations');
    assert.ok(e, 'push_generations must be registered');
    assert.strictEqual(e.replication, 'local');
  });

  it('stays rollback-exempt with a local replica rollback', () => {
    const e = L.entry('push_generations');
    assert.strictEqual(e.rollback, 'exempt');
    assert.strictEqual(e.replicaRollback, 'local');
  });
});
