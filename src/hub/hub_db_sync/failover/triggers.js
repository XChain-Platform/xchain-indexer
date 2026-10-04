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
    sync._notCaughtUpSince = null;
    sync._notCaughtUpWarned = false;
    resetForMove(sync);
    sync._bootstrapDrained = false;
    sync._failoverPendingDrain = true;
    sync._movePolicy.noteMove(reason);
    getLogger().warn('HubDbSync: moving hub from ' + previous + ' to ' + next + ' (' + reason + ')');
    return true;
}

function uncaughtUpBlocks(sync, nowMs = Date.now()) {
    if (sync._readyCaughtUp !== false) {
        if (sync._readyCaughtUp === true) {
            sync._notCaughtUpSince = null;
            sync._notCaughtUpWarned = false;
        }
        return false;
    }
    if (candidateCount(sync) >= 2) return true;
    if (sync._notCaughtUpSince === null) sync._notCaughtUpSince = nowMs;
    if (nowMs - sync._notCaughtUpSince < sync._notCaughtUpGraceMs) return true;
    if (!sync._notCaughtUpWarned) {
        sync._notCaughtUpWarned = true;
        getLogger().warn('HubDbSync: serving from the only hub although it reports not caught up');
    }
    return false;
}

function noteConnectFailure(sync) {
    const action = sync._movePolicy.onConnectFailure(candidateCount(sync));
    return action === 'move' && moveHub(sync, 'connect_failure');
}

function noteConnected(sync) {
    sync._movePolicy.noteConnected();
}

function noteHubNotCaughtUp(sync) {
    if (candidateCount(sync) < 2) return false;
    return moveHub(sync, 'hub not caught up');
}

function rejectUncaughtUpReadyFrame(sync) {
    if (sync._readyCaughtUpHandled) return false;
    sync._readyCaughtUpHandled = true;
    noteHubNotCaughtUp(sync);
    if (sync.ws) {
        try {
            if (typeof sync.ws.terminate === 'function') sync.ws.terminate();
            else if (typeof sync.ws.close === 'function') sync.ws.close();
        } catch (err) {
            getLogger().warn('HubDbSync: not-caught-up hub reconnect failed: ' + (err && err.message));
            if (sync.running) sync.scheduleBootstrapRetry();
        }
    } else if (sync.running) sync.scheduleBootstrapRetry();
    return false;
}

function stallFailoverAction(sync) {
    const action = sync._movePolicy.onStall(candidateCount(sync));
    if (action !== 'move') return action;
    return moveHub(sync, 'stall') ? 'move' : 'exit';
}

module.exports = {
    moveHub,
    noteConnectFailure,
    noteConnected,
    rejectUncaughtUpReadyFrame,
    stallFailoverAction,
    uncaughtUpBlocks
};
