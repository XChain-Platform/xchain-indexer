/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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

const assert = require('assert');
const crypto = require('crypto');

const { listMembershipHash } = require('../../../src/consensus/list_share_hash.js');

function sha256(value){
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('listMembershipHash @regression @tier1', function(){
    it('hashes a fixed two-address membership preimage', function(){
        const members = ['bc1qalpha', 'bc1qomega'];
        assert.strictEqual(
            listMembershipHash(members),
            sha256('MEMBERS|2|bc1qalpha|bc1qomega')
        );
    });

    it('hashes a one-member membership preimage', function(){
        assert.strictEqual(
            listMembershipHash(['bc1qsolo']),
            sha256('MEMBERS|1|bc1qsolo')
        );
    });

    it('hashes an empty list as exactly MEMBERS|0', function(){
        assert.strictEqual(listMembershipHash([]), sha256('MEMBERS|0'));
    });

    it('keeps the supplied member order', function(){
        const ascending = listMembershipHash(['bc1qalpha', 'bc1qomega']);
        const reversed = listMembershipHash(['bc1qomega', 'bc1qalpha']);
        assert.notStrictEqual(ascending, reversed);
    });

    it('does not mutate the input array', function(){
        const members = ['bc1qomega', 'bc1qalpha'];
        const before = members.slice();
        listMembershipHash(members);
        assert.deepStrictEqual(members, before);
    });
});
