/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * VM_TOKEN_INFO_LEGACY_WINDOW_END: below a chain's armed window end the token info the VM reads
 * through getTokenInfo leaves the BRIDGED bit out; UNARMED means no window.
 *
 * The XBRIDGE handler added BRIDGED to getTokenInfo with no gate. The VM copies a host value
 * through JSON and meters it per byte, so the 12 bytes of ,"BRIDGED":0 cost 24 gas on every
 * getTokenInfo call. The original BTC testnet fleet ran contract 74's two claims at block
 * 150698 before that release and charged 3169 and 2122. A v0.28.0 replay charged 3193 and
 * 2146, which forked the ledger hash at 150698. Every ROLLCALL signature then failed against
 * the replay's own ledger hash, nobody was evicted, and the oracle_publish roster that
 * verifies bridge checkpoints kept three stakers the network had removed (see
 * test/unit/bridge/escrow/escrow_anchor_roster.test.js).
 *
 * The fixture is contract 74 as the chain stored it (its sha256 is the stored code_hash).
 *
 ********************************************************************/

'use strict';

const assert  = require('assert');
const crypto  = require('crypto');
const mathjs  = require('mathjs');
const gates   = require('../../../../src/consensus/gate_registry');
const { gateHeightMap, classifyGateMoves } = require('../../../../src/consensus/retroactive/gate_heights.js');
const { UNARMED } = require('../../../../src/protocol_changes/core.js');
const vmPart  = require('../../../../src/db/database/controllers_vm.js');
const BTC     = require('../../../../src/coins/BTC.js');
const FIXTURE = require('../../../fixtures/tbtc_vesting_contract_74.json');

const KEY = 'vm_token_info_legacy_window.VM_TOKEN_INFO_LEGACY_WINDOW_END';
const ARMED_AT = 152738;
const CONTRACT_ADDRESS = 'C:BTC:74';

// The token info getTokenInfo builds today for VEST514 at action 89: the replayed ISSUE fields,
// then BRIDGED, then SUPPLY as the mathjs bignumber getTokenSupply returns.
function currentTokenInfo(){
    const info = Object.assign({}, FIXTURE.token_info_at_150698);
    info.SUPPLY = mathjs.bignumber(info.SUPPLY);
    return info;
}

// A database double carrying only what buildVmBalancesAndTokenInfo reads, with the real
// method bound onto it.
function loaderDb(network, coin, made){
    const db = {
        config: { NETWORK: network, COIN: coin },
        util: { isNull: (v) => v === null || v === undefined || v === '' },
        getAddressBalances: async (address) => (address === CONTRACT_ADDRESS ? { 6: '1000' } : { 1: '9997.40097' }),
        getTicker: async (tickId) => ({ 1: 'XCHAIN', 6: 'VEST514' })[tickId],
        getTokenInfo: async (symbol) => {
            const info = symbol === 'VEST514' ? currentTokenInfo()
                : { ACTION_INDEX: 6, TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8, BRIDGED: 0, SUPPLY: mathjs.bignumber('1298002.5732207') };
            made.push(info);
            return info;
        },
    };
    db.buildVmBalancesAndTokenInfo = vmPart.buildVmBalancesAndTokenInfo.bind(db);
    return db;
}

async function snapshotAt(blockIndex, network, coin){
    const made = [];
    const db = loaderDb(network || 'testnet', coin || 'BTC', made);
    const snap = await db.buildVmBalancesAndTokenInfo([FIXTURE.caller, CONTRACT_ADDRESS], blockIndex, 89);
    return { snap, made };
}

function loadVm(){
    // Loud on purpose: a binding that fails to load must fail this suite, not skip it.
    const XChainVM = require('xchain-vm');
    return new XChainVM({ gasSchedule: BTC.GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process',
        limits: { maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000, maxStateValueSize: 65536 } });
}

// Run one of the fixture's claims with the ledger snapshot the loader built.
async function runClaim(vm, call, snap){
    const ts = FIXTURE.block_time;
    return vm.execute({
        code: FIXTURE.code,
        state: Object.assign({}, FIXTURE.state_before, { claimed: call.claimed_before }),
        method: 'claim', params: [], caller: FIXTURE.caller, contractAddress: CONTRACT_ADDRESS,
        contractIndex: FIXTURE.contract_index, txHash: '00'.repeat(32),
        blockContext: { height: FIXTURE.block_index, timestamp: ts,
                        hash: crypto.createHash('sha256').update(FIXTURE.block_index + ':' + ts).digest('hex') },
        gasCeiling: 1000000, callDepth: 0, actionIndex: call.action_index, callPath: '', rootActionIndex: 0,
        network: 'testnet', balances: snap.balances, tokenInfo: snap.tokenInfo,
    });
}

describe('VM token info BRIDGED bit (VM_TOKEN_INFO_LEGACY_WINDOW_END) @regression @tier1', function(){

    it('the fixture is contract 74 byte for byte as the chain stored it', function(){
        const sha = crypto.createHash('sha256').update(FIXTURE.code, 'utf8').digest('hex');
        assert.strictEqual(sha, FIXTURE.code_sha256);
    });

    it('ends the BTC testnet window at 152738 and opens no window anywhere else', function(){
        assert.deepStrictEqual(gates.get(KEY), { mainnet: UNARMED, 'BTC:testnet': ARMED_AT, testnet: UNARMED, regtest: UNARMED });
        assert.strictEqual(gates.activeAt(KEY, 'testnet', 'BTC', ARMED_AT - 1, null), false);
        assert.strictEqual(gates.activeAt(KEY, 'testnet', 'BTC', ARMED_AT, null), true);
    });

    it('records the new BTC testnet row without replay and moves no other boot gate record', function(){
        // A node booting this build over a record written without the row: the key is new.
        for(const [network, coin] of [['testnet', 'LTC'], ['testnet', 'DOGE'], ['mainnet', 'BTC'],
                                      ['mainnet', 'LTC'], ['mainnet', 'DOGE'], ['regtest', 'BTC']]){
            const current = gateHeightMap(gates, network, coin);
            const recorded = Object.assign({}, current);
            delete recorded[KEY];
            const moves = classifyGateMoves({ recorded, current, tip: 99999999 });
            assert.strictEqual(moves.target, null, network + ' ' + coin + ' boots unchanged');
            assert.deepStrictEqual(moves.historyPreserving, []);
        }
        const current = gateHeightMap(gates, 'testnet', 'BTC');
        const recorded = Object.assign({}, current);
        delete recorded[KEY];
        // A live node records the row without replay because its prior behavior already matches.
        const live = classifyGateMoves({ recorded, current, tip: 157234 });
        assert.strictEqual(live.target, null);
        assert.deepStrictEqual(live.historyPreserving.map((m) => [m.key, m.target]), [[KEY, ARMED_AT]]);
        assert.deepStrictEqual(live.refused, []);
        // A fresh replay that has not reached the window end yet records no move.
        assert.strictEqual(classifyGateMoves({ recorded, current, tip: ARMED_AT - 1 }).target, null);
    });

    it('below the height the loader leaves BRIDGED out and keeps the other keys in order', async function(){
        const { snap, made } = await snapshotAt(FIXTURE.block_index);
        const info = snap.tokenInfo.VEST514;
        assert.ok(!('BRIDGED' in info));
        assert.deepStrictEqual(Object.keys(info),
            ['ACTION_INDEX', 'TICK', 'TICK_ID', 'OWNER', 'MAX_SUPPLY', 'MAX_MINT', 'DECIMALS', 'DESCRIPTION', 'SUPPLY']);
        assert.ok(!('BRIDGED' in snap.tokenInfo.XCHAIN));
        assert.ok(made.every((m) => 'BRIDGED' in m), 'getTokenInfo\'s own objects are not mutated');
    });

    it('from the height, and on every other network and chain, the loader passes BRIDGED through', async function(){
        for(const [height, network, coin] of [[ARMED_AT, 'testnet', 'BTC'], [FIXTURE.block_index, 'testnet', 'DOGE'],
                                              [FIXTURE.block_index, 'testnet', 'LTC'], [FIXTURE.block_index, 'mainnet', 'BTC'],
                                              [FIXTURE.block_index, 'regtest', 'BTC']]){
            const { snap } = await snapshotAt(height, network, coin);
            assert.strictEqual(snap.tokenInfo.VEST514.BRIDGED, 0, network + ' ' + coin + ' ' + height);
        }
    });

    describe('contract 74 claims at block 150698 through the real VM', function(){
        this.timeout(30000);
        let vm;
        before(function(){ vm = loadVm(); });

        it('charge the gas the original network recorded (3169 and 2122)', async function(){
            const { snap } = await snapshotAt(FIXTURE.block_index);
            for(const call of FIXTURE.calls){
                const r = await runClaim(vm, call, snap);
                assert.strictEqual(r.gasUsed, call.original_gas, 'action ' + call.action_index);
                assert.strictEqual(r.success, call.status === 'valid');
            }
        });

        it('with BRIDGED in the token info charge 24 more, the replay fork (3193 and 2146)', async function(){
            const { snap } = await snapshotAt(ARMED_AT);
            for(const call of FIXTURE.calls){
                const r = await runClaim(vm, call, snap);
                assert.strictEqual(r.gasUsed, call.rebuild_gas, 'action ' + call.action_index);
            }
        });
    });
});
