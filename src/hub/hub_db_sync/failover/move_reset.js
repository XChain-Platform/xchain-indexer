'use strict';

function resetForMove(sync) {
    sync._drainPositions = Object.create(null);
    sync._lastHubInstanceId = null;
    sync._readyMaxIds = undefined;
    sync._readyWatermark = null;
    sync._readyHeights = null;
    sync.priceSyncMaxTimestamp = 0;
    sync.oracleSyncTimestamp = null;
}

module.exports = { resetForMove };
