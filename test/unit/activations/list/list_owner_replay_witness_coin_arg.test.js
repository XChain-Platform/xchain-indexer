'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const witness = require('../../../../bin/verify-list-owner-replay-equivalence.js');

describe('LIST owner replay witness: coin argument compatibility', function () {
    const gatePrefix = "gateRegistry.activeAt('" + witness.GATE + "', this.config['NETWORK'], ";
    const nullForm = gatePrefix + 'null,';
    const coinForm = gatePrefix + "this.config['COIN'],";
    const source = fs.readFileSync(path.join(__dirname, '../../../../src/actions/list.js'), 'utf8');

    function assertRollback(input) {
        const legacy = witness.rollBackListOwner(input);
        assert.ok(!legacy.includes("gateRegistry.activeAt('" + witness.GATE + "'"));
        assert.ok(!legacy.includes("error = 'invalid: LIST_ACTION_INDEX (not owner)'"));
        assert.ok(legacy.includes('if(bridgeRoles.length){'));
        assert.ok(legacy.includes("error = 'invalid: LIST_ACTION_INDEX (bridge-owned)'"));
    }

    it('rolls back both supported owner-check coin argument forms', function () {
        assertRollback(source.split(coinForm).join(nullForm));
        assertRollback(source.split(nullForm).join(coinForm));
    });

    it('refuses a source with neither supported owner-check form', function () {
        const unsupported = source.split(nullForm).join(gatePrefix + "'unsupported',")
            .split(coinForm).join(gatePrefix + "'unsupported',");
        assert.throws(
            () => witness.rollBackListOwner(unsupported),
            /the LIST owner rollback no longer matches src\/actions\/list\.js exactly/
        );
    });
});
