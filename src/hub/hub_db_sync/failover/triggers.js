'use strict';

const { getLogger } = require('../../../observability/index.js');
const { resetForMove } = require('./move_reset.js');

function candidateCount(sync) {
    if (!sync.selector || typeof sync.selector.status !== 'function') return sync.hubUrl ? 1 : 0;
    const status = sync.selector.status();
    return Array.isArray(status.candidates) ? status.candidates.length : 0;
}

function moveHub(sync, reason) {
    if (!sync.selector || typeof sync.selector.advance !== 'function') return false;
    const previous = sync.selector.current();
    const next = sync.selector.advance(reason);
    if (!previous || !next || previous === next) return false;
    resetForMove(sync);
    sync._bootstrapDrained = false;
    sync._failoverPendingDrain = true;
    sync._movePolicy.noteMove(reason);
    getLogger().warn('HubDbSync: moving hub from ' + previous + ' to ' + next + ' (' + reason + ')');
    return true;
}

function noteConnectFailure(sync) {
    const action = sync._movePolicy.onConnectFailure(candidateCount(sync));
    return action === 'move' && moveHub(sync, 'connect_failure');
}

function noteConnected(sync) {
    sync._movePolicy.noteConnected();
}

function stallFailoverAction(sync) {
    const action = sync._movePolicy.onStall(candidateCount(sync));
    if (action !== 'move') return action;
    return moveHub(sync, 'stall') ? 'move' : 'exit';
}

module.exports = { moveHub, noteConnectFailure, noteConnected, stallFailoverAction };
