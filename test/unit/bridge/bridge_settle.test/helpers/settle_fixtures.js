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
 * The shared fixtures of the XBRIDGE settle pass suite (bridge_settle.test.js and the
 * files in bridge_settle.test/): the module under test required in its legacy arm, real
 * Ed25519 keys and signatures, real escrow proofs, signed transfer rows, and the
 * in-memory ledger ctx the settle pass runs over. The module is required once, here, so
 * every part shares one instance and one refusal memo, exactly as the single file did.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const CHK    = require('../../../../../src/consensus/bridge_checkpoint_check.js');

// THE LEGACY ARM, EXPLICITLY. Every row below is a regtest row with no admission columns,
// which is a legacy row only while the mirror-admission activation is inert; in a process
// launched armed (XC_MIRROR_ADMISSION_ACTIVATION set) the canonicals REFUSE such a row,
// correctly, and every quorum case here would fail for a reason that is not its subject.
// The activation freezes at require time, so the module under test is required with the
// env unset and the require cache is put back at once: this file drives the legacy arm,
// admission_binding.test.js drives the armed one. The purge/re-require idiom is the same
// one the price and follower-bound suites carry by hand (frontier row 25).
function requireDisarmed(mod){
    const twin  = require.resolve('../../../../../src/mirror_admission_activation.js');
    const target = require.resolve(mod);
    const saved = [[twin, require.cache[twin]], [target, require.cache[target]]];
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    delete require.cache[twin];
    delete require.cache[target];
    try {
        return require(mod);
    } finally {
        for(const [p, m] of saved){ if(m === undefined) delete require.cache[p]; else require.cache[p] = m; }
        if(savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
}
const BS     = requireDisarmed('../../../../../src/consensus/bridge_settle.js');
const M      = require('../../../../../src/consensus/merkle.js');
const SUB    = require('../../../../../src/state_subtree_activation.js');
const Utility = require('../../../../../src/utility.js');
const bridgeSettlementsMixin = require('../../../../../src/db/bridge_settlements/index.js');

// Give a connection double the REAL db/bridge_settlements methods, bound over its own
// doQuery. The settle pass reaches both the local ledger and the mirror through those
// methods, so binding them here is what keeps every SQL matcher below reading the exact
// statements that ship instead of statements the test invented.
function bindSettlementReads(db){
    for(const m of Reflect.ownKeys(bridgeSettlementsMixin))
        db[m] = bridgeSettlementsMixin[m].bind(db);
    return db;
}

// Ed25519 keypair whose raw 32-byte pubkey / 64-byte sig hex match src/consensus/ed25519.js verify().
function makeKey(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: spki.subarray(spki.length - 32).toString('hex'), privateKey };
}
function sign(privateKey, msg){
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}

const NETWORK  = 'regtest';
const SNAPSHOT = 1200;
const DEST_ADDR = 'nDestinationAddressXXXXXXXXXXXXXXX';
const ESCROW_DOGE_ON_BTC = 'mBTCEscrowForDogeXXXXXXXXXXXXXXXXX';
const ESCROW_BTC_ON_DOGE = 'nDOGEEscrowForBtcXXXXXXXXXXXXXXXXX';

// The REAL escrow address the cross-check resolves for BTC -> DOGE on this network, read
// through the same door the check reads it (the origin chain's own coin config). A fixture
// address here would make every in-leg proof fail PROOF_BINDING and hide whatever the ledger
// assertions below were really proving.
const REAL_ESCROW = CHK.resolveEscrowAddress('BTC', 'DOGE', NETWORK);
const OTHER_HOLDER = 'mSomeOtherHolderXXXXXXXXXXXXXXXXXX';
const CP_HEIGHT    = 1205;      // the first checkpoint at or after SNAPSHOT

// A full, VALID escrow proof envelope for `balance` of `tick`, built from the real sparse
// Merkle tree and the real state-root assembly, the way the escrow cross-check's own suite builds one: the root
// is a real root and the inclusion proof comes out of merkle.js, so "the cross-check passed"
// means the same arithmetic a producing node does.
function buildProof(balance, tick){
    const t   = tick || 'XCHAIN';
    const smt = new M.SparseMerkleTree();
    smt.set(M.balanceKey('BTC', NETWORK, REAL_ESCROW, t), M.amountLeaf(balance));
    smt.set(M.balanceKey('BTC', NETWORK, OTHER_HOLDER, t), M.amountLeaf('41.5'));
    const subRoots = { balances_root: smt.rootHex(), stakes_root: M.toHex(M.EMPTY_SMT_ROOT) };
    return {
        chain: 'BTC', network: NETWORK, block_index: CP_HEIGHT,
        sub_roots: subRoots,
        address: REAL_ESCROW, tick: t, balance: balance,
        balance_proof: { siblings: smt.prove(M.balanceKey('BTC', NETWORK, REAL_ESCROW, t)).siblings },
        checkpoint: {
            chain: 'BTC', network: NETWORK, block_index: CP_HEIGHT, checkpoint_seq: 77,
            snapshot_block: CP_HEIGHT,
            state_root: M.toHex(M.stateRoot(subRoots)),
            state_root_version: SUB.stateRootVersion(CP_HEIGHT, NETWORK, 'BTC')
        }
    };
}

// A transfer row as the hub signs and the mirror delivers it. `signers` sign the module's own
// canonical, so a correctly built row verifies and a tampered one does not.
function makeTransfer(signers, overrides){
    const row = Object.assign({
        transfer_id:    'a'.repeat(64),
        snapshot_block: SNAPSHOT,
        network:        NETWORK,
        src_chain:      'BTC',
        src_action_index: 4242,
        src_address:    'mSourceAddressXXXXXXXXXXXXXXXXXXXX',
        dest_chain:     'DOGE',
        dest_address:   DEST_ADDR,
        tick:           'XCHAIN',
        decimals:       8,
        amount:         '10.00000000',
        effective_time: 1000,
        finalizing_view: 0,
        status:         'finalized',
        push_generation: 0,
        btc_chain_id:   null
    }, overrides || {});
    row.validator_signatures = JSON.stringify(
        (signers || []).map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, BS.transferCanonical(row)) })));
    return row;
}

// Three validators, three distinct staking sources, equal weight: a 3-of-3 signature set is
// over two thirds and a 1-of-3 is not, under both the weighted and the 2f+1 rule.
function snapshotSet(keys){
    return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
}

// The mirror database double: bridge_transfers and policy_snapshots reads over the rows the
// case handed in, bound to the real db/bridge_settlements methods like the ledger double.
function makeMirrorDouble(state){
    return bindSettlementReads({
        doQuery: async (sql, args) => {
            if(/FROM bridge_transfers/.test(sql)){
                const rows = state.mirrorTransfers.slice();
                // A real database applies the query's own ORDER BY. The fake honours it only
                // when the SQL actually asks for it, so the ordering case below proves the
                // QUERY carries the consensus order rather than proving the fixture was
                // already sorted.
                if(/ORDER BY snapshot_block ASC, transfer_id ASC/.test(sql))
                    rows.sort((a, b) => (Number(a.snapshot_block) - Number(b.snapshot_block)) ||
                                        (String(a.transfer_id) < String(b.transfer_id) ? -1 : 1));
                return rows;
            }
            if(/FROM policy_snapshots/.test(sql)) return state.mirrorPolicies.slice();
            return [];
        }
    });
}

// The local ledger's doQuery: the bridge_settlements reads and the settlement insert over
// the in-memory state, so the real mixin methods bound over it issue the shipped SQL.
function ledgerQuery(state){
    return async (sql, args) => {
        // The source-leg uniqueness read, keyed on (src_chain, src_action_index). Answered
        // before the id-keyed branch below, which would otherwise swallow it on LIMIT 1 and
        // report every leg unsettled.
        if(/FROM bridge_settlements/.test(sql) && /src_action_index = \?/.test(sql))
            return state.settledLegs.has(String(args[0]) + ':' + String(args[1]))
                ? [{ transfer_id: 'e'.repeat(64) }] : [];
        // The due-set sweep: two IN lists, chains then indexes. Faithfully over-selects the
        // CROSS PRODUCT the way a real database does, so the pair matching in the module is
        // exercised instead of being handed pre-matched rows.
        if(/FROM bridge_settlements/.test(sql) && /src_action_index IN/.test(sql)){
            const nChains = ((sql.match(/src_chain IN \(([^)]*)\)/) || ['', ''])[1].match(/\?/g) || []).length;
            const chains  = (args || []).slice(0, nChains).map(String);
            const idxs    = (args || []).slice(nChains).map(Number);
            return [...state.settledLegs]
                .map(k => ({ src_chain: k.slice(0, k.indexOf(':')),
                             src_action_index: Number(k.slice(k.indexOf(':') + 1)) }))
                .filter(r => chains.includes(r.src_chain) && idxs.includes(r.src_action_index));
        }
        if(/FROM bridge_settlements/.test(sql) && /LIMIT 1/.test(sql))
            return state.settled.has(String(args[0]) + '|' + String(args[1])) ? [{ transfer_id: args[0] }] : [];
        if(/FROM bridge_settlements/.test(sql)){
            const kind = /kind = 'policy'/.test(sql) ? 'policy' : 'transfer';
            return (args || []).filter(id => state.settled.has(String(id) + '|' + kind))
                               .map(id => ({ transfer_id: id }));
        }
        if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
            state.settlements.push({ action_index: args[0], transfer_id: args[1], kind: args[2], block_index: args[3],
                                     src_chain: args[4], src_action_index: args[5] });
            state.settled.add(String(args[1]) + '|' + String(args[2]));
            // The source leg the insert captured, which is what makes a SECOND row naming it
            // visible to the next read in the same block, exactly as the real table does.
            if(String(args[2]) === 'transfer' && args[4] !== null && args[5] !== null &&
               args[4] !== undefined && args[5] !== undefined)
                state.settledLegs.add(String(args[4]) + ':' + String(args[5]));
            return [];
        }
        return [];
    };
}

// The local ledger double the settle pass writes through: the bridge_settlements reads and
// insert (ledgerQuery), the validator snapshot, token lookups, and credit/debit capture.
function makeLedgerDouble(config, state, o, counter, mirror){
    return bindSettlementReads({
        config: config,
        mirrorDb: () => mirror,
        doQuery: ledgerQuery(state),
        getValidatorsByCapability: async () => (o.validators || []),
        getStakeWeightsByCapability: async () => (o.validators || []),
        createActionIndex: async (data) => { state.actions.push(data); return counter.nextAction++; },
        getTokenInfo: async (tick) => (o.tokens || {})[tick] || null,
        getTickerId: async (tick) => ((o.tokens || {})[tick] ? (o.tokens || {})[tick]['TICK_ID'] : null),
        getAddressBalances: async () => Object.assign({}, state.balances),
        createDebit:  async (ai, tick, amount, address) => { state.debits.push([tick, amount, address]); },
        createCredit: async (ai, tick, amount, address) => { state.credits.push([tick, amount, address]); },
        createEscrow: async () => {},
        updateBalances: async () => {},
        updateTokens:   async () => {},
        getList:        async () => [],
        isTickSleeping: async () => false
    });
}

// A settle-pass ctx over an in-memory ledger. Every method the apply reaches is here; nothing
// is stubbed that the apply would otherwise have computed itself.
function makeCtx(opts){
    const o = opts || {};
    const config = {
        COIN:    o.coin || 'DOGE',
        NETWORK: NETWORK,
        GAS:     'XCHAIN',
        ADDRESS: { GAS: 'nGasOwnerXXXXXXXXXXXXXXXXXXXXXXXXX',
                   BRIDGE_BTC:  ESCROW_BTC_ON_DOGE,
                   BRIDGE_DOGE: ESCROW_DOGE_ON_BTC },
        BTC_CHAIN_ID: o.chainId || null
    };
    const state = {
        credits: [], debits: [], settlements: [], actions: [], mappings: [],
        balances: o.balances || {},          // tick_id -> amount, for the escrow address
        settled:  new Set(o.settled || []),
        // The applied SOURCE LEGS, '<src_chain>:<src_action_index>', the second idempotency key
        // the real table carries as idx_src_ref. Modelled separately from `settled` because the
        // whole point of the refusal is that one leg can arrive under several transfer ids.
        settledLegs: new Set(o.settledLegs || []),
        mirrorTransfers: o.mirrorTransfers || [],
        mirrorPolicies:  o.mirrorPolicies  || [],
        injected: []
    };
    // One action-index counter shared by the ledger's createActionIndex and the injected
    // processTransaction, so both draw from one sequence as they would on one node.
    const counter = { nextAction: 5000 };

    const mirror = makeMirrorDouble(state);
    const db = makeLedgerDouble(config, state, o, counter, mirror);
    const util = new Utility(config);
    const ctx = {
        actions:   { processTransaction: async (tx) => { state.injected.push(tx); return { ACTION_INDEX: counter.nextAction++, STATUS: 'valid' }; },
                     mapper: { createMappings: async (d) => { state.mappings.push(d); } } },
        indexerDb: db,
        util:      util,
        mapper:    { createMappings: async (d) => { state.mappings.push(d); } },
        config:    config,
        coin:      config.COIN,
        network:   NETWORK,
        blockIndex: 900,
        blockTime:  2000
    };
    return { ctx, state, config };
}

// Two finalized rows for ONE source leg: different transfer_id AND different
// snapshot_block, which is the shape measured on the rail (eleven finalized rows for
// seven source actions, 120 minted against 80 locked). The id-keyed idempotency filter
// cannot see it, because snapshot_block is inside transfer_id by design,
// so both rows are legitimately-signed, distinct, unapplied rows to every earlier guard.
function duplicatePair(keys, overrides){
    const base = Object.assign({}, overrides || {});
    return [makeTransfer(keys, Object.assign({}, base, { transfer_id: '1'.repeat(64), snapshot_block: SNAPSHOT })),
            makeTransfer(keys, Object.assign({}, base, { transfer_id: '2'.repeat(64), snapshot_block: SNAPSHOT + 1 }))];
}

function selectorCtx(anchorRows, mirrorRows){
    const { ctx } = makeCtx({ coin: 'DOGE' });
    ctx.indexerDb.doQuery = async (sql) => (/FROM anchor_actions/.test(sql) ? anchorRows : []);
    ctx.indexerDb.mirrorDb = () => bindSettlementReads({ doQuery: async () => mirrorRows });
    // The two reads are the real db mixin methods over those stubs, not stubs of their
    // own, so the anchor leg still has to issue SQL naming anchor_actions to see a row
    // and the mirrored leg still has to route through mirrorDb() to see one.
    const anchorsMixin = require('../../../../../src/db/anchors');
    ctx.indexerDb.getEarliestValidAnchorCheckpoint =
        anchorsMixin.getEarliestValidAnchorCheckpoint.bind(ctx.indexerDb);
    ctx.indexerDb.getMirroredStateCheckpointCandidates =
        anchorsMixin.getMirroredStateCheckpointCandidates.bind(ctx.indexerDb);
    return ctx;
}

// Every method the module reaches goes through console.log/console.warn, never through
// a logger object, so capturing both globals for the duration of fn() is the only way to
// read what a settle pass actually printed. Always restored, even if fn() throws.
async function captureConsole(fn){
    const lines = [];
    const origLog = console.log, origWarn = console.warn;
    console.log  = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.log = origLog; console.warn = origWarn; }
    return lines;
}

module.exports = {
    BS, bindSettlementReads, makeKey, sign, NETWORK, SNAPSHOT, DEST_ADDR, ESCROW_DOGE_ON_BTC,
    ESCROW_BTC_ON_DOGE, REAL_ESCROW, OTHER_HOLDER, CP_HEIGHT, buildProof, makeTransfer,
    snapshotSet, makeCtx, duplicatePair, selectorCtx, captureConsole
};
