/*********************************************************************
 *
 * Conformance: the ADDRESS-reference field map (the wire ^<id> consensus
 * surface) MUST be byte-identical between the indexer and the SDK.
 *
 * The indexer assigns and resolves index ids for exactly the fields in
 * ADDRESS_REF_FIELDS; the SDK compacts addresses to ^<id> for the subset in
 * SDK_COMPACTABLE. If the two copies drift, the SDK could emit a ^<id> the
 * indexer would not recognise (or vice versa), reintroducing the exact
 * divergence this feature closes. This guard reads both files directly so any
 * edit to one without the other fails CI.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const INDEXER_FILE = path.join(__dirname, '..', '..', 'src', 'addressRefFields.js');
const SDK_FILE     = path.join(__dirname, '..', '..', '..', 'xchain-sdk', 'src', 'addressRefFields.js');

describe('addressRefFields.js conformance (indexer <-> sdk) @regression', function () {

    it('the indexer copy parses and exports the expected shape', function () {
        const m = require(INDEXER_FILE);
        assert.ok(m && typeof m.ADDRESS_REF_FIELDS === 'object', 'ADDRESS_REF_FIELDS export missing');
        assert.ok(Array.isArray(m.SDK_COMPACTABLE), 'SDK_COMPACTABLE export missing');
        // SDK_COMPACTABLE is the single-value, non-type-gated subset.
        const derived = new Set();
        for (const action of Object.keys(m.ADDRESS_REF_FIELDS))
            for (const spec of m.ADDRESS_REF_FIELDS[action])
                if (!spec.multi && !spec.listType) derived.add(spec.field);
        assert.deepStrictEqual(
            [...m.SDK_COMPACTABLE].sort(),
            [...derived].sort(),
            'SDK_COMPACTABLE must be exactly the single-value (non-multi, non-listType) fields'
        );
    });

    it('is byte-identical to the SDK copy (cross-repo drift guard)', function () {
        if (!fs.existsSync(SDK_FILE)) {
            // Sibling SDK repo not checked out (standalone indexer deploy): the
            // cross-repo source of truth is unavailable, so skip rather than error.
            this.skip();
            return;
        }
        const indexerSrc = fs.readFileSync(INDEXER_FILE, 'utf8');
        const sdkSrc     = fs.readFileSync(SDK_FILE, 'utf8');
        assert.strictEqual(
            sdkSrc,
            indexerSrc,
            'xchain-indexer/src/addressRefFields.js and xchain-sdk/src/addressRefFields.js have drifted. ' +
            'They define the wire ^<id> consensus surface and MUST be byte-identical; reconcile them.'
        );
    });
});
