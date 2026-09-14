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
 *
 **********************************************************************
 *
 * XChain Indexer - Actions class: handler wiring
 *
 * Loads every action handler class and constructs one instance of each onto the Actions
 * loader, in two runs: the handlers that need no VM, then (once the constructor has loaded
 * and gated the VM) the VM, staking, oracle and cross-chain handlers. Every handler is
 * constructed with the Actions instance itself, which is how it reaches the shared db,
 * util and config handles.
 *
 ********************************************************************/

// Load indexer actions
const address          = require('../address.js');
const airdrop          = require('../airdrop.js');
const batch            = require('../batch.js');
const bet              = require('../bet.js');
const bet_expire       = require('../bet_expire.js');
const broadcast        = require('../broadcast.js');
const callback         = require('../callback.js');
const coinpay          = require('../coinpay.js');
const coinpay_expire   = require('../coinpay_expire.js');
const destroy          = require('../destroy.js');
const dispenser        = require('../dispenser.js');
const dispenser_close  = require('../dispenser_close.js');
const dispenser_expire = require('../dispenser_expire.js');
const dispense         = require('../dispense.js');
const dividend         = require('../dividend.js');
const file             = require('../file.js');
const issue            = require('../issue.js');
const link             = require('../link.js');
const list             = require('../list.js');
const message          = require('../message.js');
const mint             = require('../mint.js');
const order            = require('../order.js');
const order_expire     = require('../order_expire.js');
const order_match      = require('../order_match.js');
const sleep            = require('../sleep.js');
const send             = require('../send.js');
const swap             = require('../swap.js');
const swap_expire      = require('../swap_expire.js');
const swap_match       = require('../swap_match.js');
const cross_settle     = require('../cross_settle/index.js');
const sweep            = require('../sweep.js');
const unknown          = require('../unknown.js');

// VM actions
const deploy             = require('../deploy/index.js');
const execute            = require('../execute/index.js');
const deposit            = require('../deposit.js');
const withdraw           = require('../withdraw.js');
const vote               = require('../vote.js');

// Staking actions
const stake              = require('../stake.js');
const unstake            = require('../unstake.js');
const delegate           = require('../delegate.js');
const collect            = require('../collect.js');
const slash              = require('../slash.js');

// PRICE action (validator snapshots and user oracle prices)
const price              = require('../price/index.js');

// External attestation framework (single action; v0=request, v1=response, v2=expire)
const attest             = require('../attest/index.js');

// ANCHOR: DOGE-only on-chain state commitments (v0=checkpoint bundle, v1=archive head,
// v2=archive continuation chunk; the pre-restart v3-v7 set no longer parses).
// Authoritative list: anchor.js FORMATS.
const anchor             = require('../anchor/index.js');

// Cross-chain contract calls: XCALL (source-chain request/expiry) + XEXEC
// (target-chain mirror-driven execution injection)
const xcall              = require('../xcall/index.js');
const xexec              = require('../xexec.js');

// Cross-chain token bridge: XBRIDGE (v0/v3 lock, v1/v4 burn, v2/v5 mirror-injected settle)
const xbridge            = require('../xbridge/index.js');

// Full-node possession-proof verdict (verified-validator tier)
const nodeproof          = require('../nodeproof.js');
const rollcall           = require('../rollcall/index.js');

// The handlers that need no VM, constructed before the constructor loads and gates it.
function wireCoreHandlers(actions){
    actions.actionAddress         = new address(actions);
    actions.actionAirdrop         = new airdrop(actions);
    actions.actionBatch           = new batch(actions);
    actions.actionBroadcast       = new broadcast(actions);
    actions.actionCallback        = new callback(actions);
    actions.actionCoinpay         = new coinpay(actions);
    actions.actionCoinpayExpire   = new coinpay_expire(actions);
    actions.actionDestroy         = new destroy(actions);
    actions.actionDispenser       = new dispenser(actions);
    actions.actionDispenserClose  = new dispenser_close(actions);
    actions.actionDispenserExpire = new dispenser_expire(actions);
    actions.actionDispense        = new dispense(actions);
    actions.actionFile            = new file(actions);
    actions.actionDividend        = new dividend(actions);
    actions.actionIssue           = new issue(actions);
    actions.actionLink            = new link(actions);
    actions.actionList            = new list(actions);
    actions.actionMessage         = new message(actions);
    actions.actionMint            = new mint(actions);
    actions.actionBet             = new bet(actions);
    actions.actionBetExpire       = new bet_expire(actions);
    actions.actionOrder           = new order(actions);
    actions.actionOrderExpire     = new order_expire(actions);
    actions.actionOrderMatch      = new order_match(actions);
    actions.actionSleep           = new sleep(actions);
    actions.actionSend            = new send(actions);
    actions.actionSwap            = new swap(actions);
    actions.actionSwapExpire      = new swap_expire(actions);
    actions.actionSwapMatch       = new swap_match(actions);
    actions.actionCrossSettle     = new cross_settle(actions);
    actions.actionSweep           = new sweep(actions);
    actions.actionUnknown         = new unknown(actions);
}

// The handlers constructed after the VM is loaded and gated (actions.vm is set by then).
function wireProtocolHandlers(actions){
    // VM action instances
    actions.actionDeploy           = new deploy(actions);
    actions.actionExecute          = new execute(actions);
    actions.actionDeposit          = new deposit(actions);
    actions.actionWithdraw         = new withdraw(actions);
    actions.actionVote             = new vote(actions);

    // Staking action instances
    actions.actionStake            = new stake(actions);
    actions.actionUnstake          = new unstake(actions);
    actions.actionDelegate         = new delegate(actions);
    actions.actionCollect          = new collect(actions);
    actions.actionSlash            = new slash(actions);

    // PRICE action instance
    actions.actionPrice            = new price(actions);

    // Attestation framework action instance (single handler dispatches v0/v1/v2 internally)
    actions.actionAttest           = new attest(actions);

    // ANCHOR action instance (single handler dispatches v0/v1/v2 internally)
    actions.actionAnchor           = new anchor(actions);

    // NODEPROOF: full-node possession-proof verdict handler
    actions.actionNodeproof        = new nodeproof(actions);

    // ROLLCALL: validator liveness presence proofs (DOGE-gated in the handler)
    actions.actionRollcall         = new rollcall(actions);

    // Cross-chain contract call instances (XCALL dispatches v0/v2 internally;
    // XEXEC is the target-chain injection handler)
    actions.actionXcall            = new xcall(actions);
    actions.actionXexec            = new xexec(actions);

    // Bridge lock/burn instance (the settle legs are applied by bridge_settle.js)
    actions.actionXbridge          = new xbridge(actions);
}

module.exports = { wireCoreHandlers, wireProtocolHandlers };
