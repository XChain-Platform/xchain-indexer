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
 * XChain Indexer - the GET /status route.
 *
 * Mounts the plain REST status endpoint; the verdict, the hub mirror snapshot and
 * the response body it answers with are built by ./status_route.
 *
 ********************************************************************/

const { committedView, inFlightBlockIndex } = require('./health');
const { readDecoderBlock, hubMirrorStatus, statusVerdict, statusBody } = require('./status_route');

// Plain REST status endpoint for monitoring tools that poll over a simple
// GET: uptime checks, container liveness/readiness probes, and load-balancer
// health checks that cannot speak the JSON-RPC envelope the JSON-RPC methods
// require. Surfaces the indexer's current block height, the decoder's current
// tip, the computed indexer→decoder lag, and the sync flag, so quantitative
// lag is readable from the public API surface without direct database access.
// The indexer block is read fresh from the DB (same source and same
// committed-only view as the `health` method) so it neither reports a stale
// in-memory counter nor advertises an uncommitted one.
function mountStatusRoute(app, { indexer, XChainIndexer }){
    app.get('/status', async (req, res) => {
        let indexerBlock = null;
        let indexerDbUnreachable = false;
        // Same committed-vs-in-flight split as health: indexerBlock is
        // the height a committed-only reader (every federation query guard) can
        // answer at; inFlightBlock is the block being parsed right now, which is
        // not indexed yet and a reorg may mean it never is.
        let inFlightBlock = inFlightBlockIndex(indexer.indexerDb);
        try {
            if(indexer.indexerDb)
                indexerBlock = await committedView(indexer.indexerDb).getLatestBlockIndex();
        } catch (err) {
            // Database unreachable; leave indexerBlock null so lag stays null
            // rather than reporting a misleading figure.
            indexerDbUnreachable = true;
        }
        if(inFlightBlock != null && indexerBlock != null && inFlightBlock <= indexerBlock)
            inFlightBlock = null;
        // Fresh from the decoder DB, falling back to the in-memory snapshot when
        // that database is unreachable (./status_route).
        let decoderBlock = await readDecoderBlock(indexer);
        // The hub config age and the stall verdict, all off one clock read
        // (./status_route), then the hub mirror snapshot.
        let verdict   = statusVerdict(XChainIndexer, indexer);
        let hubMirror = hubMirrorStatus(indexer);
        // Status-code contract for the xchain-node http_get healthcheck (wget
        // exits 0 on any 2xx): 503 when the indexer DB is unreachable or the
        // block counter is genuinely WEDGED, matching the encoder / utxo-tracker /
        // sync siblings. A set stallReason ALONE no longer trips 503: a
        // BTC-mainnet indexer perpetually defers the newest block behind a price
        // mirror one block back, so it is almost always mid-barrier at probe time
        // even though it advances every few seconds. Reserve 503 for a stall with
        // no committed block inside the grace window; a stalled-but-advancing
        // indexer stays 200 with degraded:true. isSynced=false alone likewise
        // stays 200: a healthy initial catch-up must not trip restart loops.
        let unhealthy = indexerDbUnreachable || verdict.wedged;
        res.status(unhealthy ? 503 : 200).json(statusBody(XChainIndexer, indexer,
            { indexerBlock, inFlightBlock, decoderBlock, verdict, hubMirror }));
    });
}

module.exports = { mountStatusRoute };
