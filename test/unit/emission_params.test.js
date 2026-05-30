/*********************************************************************
 * MANDATORY: Emission Params Arity Test
 *
 * When a contract emits an action from inside the VM, Execute.buildActionParams()
 * turns the emission's named params into the POSITIONAL params array that the
 * target action handler's parser expects. That array MUST have exactly as many
 * slots as the handler's `formats[0]` has pipe-delimited fields — otherwise the
 * emitted action silently misaligns (a value lands in the wrong column) or the
 * parser under/over-reads.
 *
 * This drift is exactly what bit us: several feature initiatives (token-ownership
 * trading, gated FILE, MESSAGE coin-scoping, PRICE-v1 oracle) extended handler
 * formats[0] but not buildActionParams. The bugs were invisible until on-chain.
 *
 * This test pins both sides to the REAL source of truth:
 *   - the arity comes from the live `Execute.prototype.buildActionParams`
 *   - the expected field count comes from each handler's live `formats[0]`
 * so a change to EITHER without the other fails here, before production.
 *
 * (The previous version of this test copied buildActionParams into the test file
 * and hard-coded the field counts — both drifted stale and it could never have
 * caught the very class of bug it was meant to. Do not reintroduce a local copy.)
 ********************************************************************/

const assert  = require('assert');
const Execute = require('../../src/actions/execute.js');

// Every action that can be emitted from a VM contract — must stay in lock-step
// with Execute.getActionHandler()'s map and the buildActionParams() switch.
// Maps the action name to its handler module.
const EMITTABLE_HANDLERS = {
    'SEND':      require('../../src/actions/send.js'),
    'DESTROY':   require('../../src/actions/destroy.js'),
    'ISSUE':     require('../../src/actions/issue.js'),
    'MINT':      require('../../src/actions/mint.js'),
    'ORDER':     require('../../src/actions/order.js'),
    'DISPENSER': require('../../src/actions/dispenser.js'),
    'DIVIDEND':  require('../../src/actions/dividend.js'),
    'AIRDROP':   require('../../src/actions/airdrop.js'),
    'CALLBACK':  require('../../src/actions/callback.js'),
    'FILE':      require('../../src/actions/file.js'),
    'LIST':      require('../../src/actions/list.js'),
    'COINPAY':   require('../../src/actions/coinpay.js'),
    'SWEEP':     require('../../src/actions/sweep.js'),
    'LINK':      require('../../src/actions/link.js'),
    'BROADCAST': require('../../src/actions/broadcast.js'),
    'MESSAGE':   require('../../src/actions/message.js'),
    'ATTEST':    require('../../src/actions/attest.js')
};

// buildActionParams() does not touch `this`; call it directly off the prototype.
const buildActionParams = Execute.prototype.buildActionParams;

// Handler constructors only read properties off the `action` registry and assign
// them — they never call into the deps during construction — so a recursive stub
// that answers any property access (and any call) lets us reach `this.formats`
// without standing up a DB / config / util layer.
function makeStub(){
    return new Proxy(function(){}, { get: () => makeStub(), apply: () => makeStub() });
}

// The pipe-delimited field count of a handler's primary (version 0) format.
function formatFieldCount(HandlerClass){
    const handler = new HandlerClass(makeStub());
    assert(handler.formats && typeof handler.formats[0] === 'string',
        'handler has no string formats[0]');
    return handler.formats[0].split('|').length;
}

describe('Emission Params Arity (MANDATORY) @regression @tier1', function() {

    for(const [action, HandlerClass] of Object.entries(EMITTABLE_HANDLERS)){
        it(action + ': buildActionParams arity === handler formats[0] field count', function() {
            const expected = formatFieldCount(HandlerClass);
            // Length is fixed by the array literal in each case, independent of the
            // param values, so an empty params object yields the canonical arity.
            const built = buildActionParams.call(null, action, {});
            assert.strictEqual(built.length, expected,
                action + ': buildActionParams produced ' + built.length + ' positional params but ' +
                'handler formats[0] declares ' + expected + ' fields — emission would misalign. ' +
                'Update Execute.buildActionParams (src/actions/execute.js) to match the handler format.');
            // VERSION slot is always 0 (format[0] handlers).
            assert.strictEqual(built[0], 0, action + ': first positional param (VERSION) must be 0');
        });
    }

    it('buildActionParams handles every emittable action and rejects unknown ones', function() {
        for(const action of Object.keys(EMITTABLE_HANDLERS)){
            assert.doesNotThrow(() => buildActionParams.call(null, action, {}),
                'buildActionParams should handle emittable action ' + action);
        }
        assert.throws(() => buildActionParams.call(null, 'NOPE', {}), /unsupported emission action/);
    });

    // Spot-check critical field ordering (camelCase param -> positional slot).
    // These guard the columns most prone to silent misalignment.

    it('ORDER: GIVE_AMOUNT@3, GIVE_OWNERSHIP@4, GET_AMOUNT@7, GET_OWNERSHIP@8', function() {
        const r = buildActionParams.call(null, 'ORDER', {
            giveCoin: 'BTC', giveTick: 'T', giveAmount: 'GA', giveOwnership: 'GO',
            getCoin: 'BTC', getTick: 'G', getAmount: 'TA', getOwnership: 'TO'
        });
        assert.strictEqual(r[3], 'GA');   // GIVE_AMOUNT
        assert.strictEqual(r[4], 'GO');   // GIVE_OWNERSHIP
        assert.strictEqual(r[7], 'TA');   // GET_AMOUNT
        assert.strictEqual(r[8], 'TO');   // GET_OWNERSHIP
    });

    it('MESSAGE: COIN@1, DESTINATION@2 (destination must not collapse into the COIN slot)', function() {
        const r = buildActionParams.call(null, 'MESSAGE', { coin: 'BTC', destination: 'D' });
        assert.strictEqual(r[1], 'BTC');  // COIN
        assert.strictEqual(r[2], 'D');    // DESTINATION
    });

    it('FILE: trailing gated-file fields present (GATE_TICKER@5, ENCRYPTION_METHOD@6, KEY_HASH@7)', function() {
        const r = buildActionParams.call(null, 'FILE', {
            name: 'f', type: 't', title: 'T', gateTicker: 'GT', encryptionMethod: 'EM', keyHash: 'KH'
        });
        assert.strictEqual(r[5], 'GT');   // GATE_TICKER
        assert.strictEqual(r[6], 'EM');   // ENCRYPTION_METHOD
        assert.strictEqual(r[7], 'KH');   // KEY_HASH
    });
});
