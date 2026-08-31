# Shared observability module

A dependency-free Prometheus `/metrics` exporter plus a structured log shim,
vendored byte-identically into every `xchain-*` service.

**Canonical copy: `xchain-hub/src/observability/`.** Edit here, then run
`xchain-hub/bin/sync-observability.sh` to push the copies out. A parity check
across the vendored copies fails on drift; run it locally with
`xchain-hub/bin/sync-observability.sh --check`.

## Wiring a service

Two calls, and the first one goes at the very TOP of the entry file, above the
env-validation gates:

```js
const { patchConsole } = require('./observability');
patchConsole({ service: 'xchain-hub', version: require('../package.json').version });
```

That routes the service's existing bare `console.*` calls through the shim, so
`LOG_LEVEL`, `LOG_FORMAT` and secret redaction apply to every call site without
rewriting one of them. It has to run before anything logs: every service emits
its env-validation and crash lines hundreds of lines ahead of
`installObservability`, and those are the lines an operator most needs framed.

Then, where the Express app exists:

```js
const { installObservability } = require('./observability');

const observability = installObservability(app, {
    service: 'xchain-hub',
    version: require('../package.json').version,
    coin:    process.env.INDEXER_COIN || '',
    network: process.env.INDEXER_NETWORK || ''
});
```

Call it right after `helmet`/`cors`/`express.json` and before the routes, so the
request timer wraps every handler. It returns
`{ enabled, config, registry, logger, shutdown }`.

Modules that need to emit an event with FIELDS (a patched `console` line cannot
carry any) take `getLogger()`, which resolves lazily and is safe to call at
require time:

```js
const { getLogger } = require('./observability');
const log = getLogger();
log.warn('PBFT_DROP', { reason: 'digest_mismatch', phase: 'prepare', round });
```

## The default text line

The fleet runs text mode, so text mode carries the whole record:

```
2026-08-30T17:11:25.030Z warn [xchain-hub] PBFT_DROP reason=digest_mismatch phase=prepare round=42
```

The message sits immediately after the service tag so every existing substring
grep across the platform keeps matching: the prefix is the only addition. The
level token is lowercase deliberately: the server-monitor agent
counts `grep -cE 'ERROR|FATAL'` per container and pages at 50/min, so an
uppercase token would make every `console.error` line count and page the fleet
on first deploy.

## Everything is off by default

With no env set: no route is registered, no timer starts and no socket opens.
Turning any of that on is an operator decision.

The metrics REGISTRY is the one exception, and it is always constructed. Gating
it on `METRICS_ENABLED` meant a counter registered by a consensus module did not
exist at all on the default fleet, which is every box: nothing could record into
it, so enabling metrics later started from zero history rather than revealing
what had happened. Only the endpoint is gated.

| Env | Default | Effect |
| --- | --- | --- |
| `METRICS_ENABLED` | off | Serve the scrape endpoint |
| `METRICS_PATH` | `/metrics` | Scrape path |
| `METRICS_TOKEN` | unset | Require `Authorization: Bearer <token>` (timing-safe) |
| `METRICS_HTTP` | on when metrics on | Per-request counters and latency histogram |
| `LOG_FORMAT` | `text` | `json` emits NDJSON records |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `XCHAIN_LOG_PATCH` | on | `0` leaves `console.*` alone; every repo's test bootstrap sets it |
| `LOG_SHIP_ENABLED` | off | Ship batches; needs `LOG_SHIP_URL` too |
| `LOG_SHIP_URL` | unset | Collector endpoint (http/https), NDJSON body |
| `LOG_SHIP_TOKEN` | unset | Bearer token for the collector; never logged |
| `LOG_SHIP_BATCH_SIZE` | 100 | Lines per POST |
| `LOG_SHIP_INTERVAL_MS` | 5000 | Flush interval |
| `LOG_SHIP_MAX_BUFFER` | 5000 | Bounded buffer; oldest dropped and counted |
| `LOG_SHIP_TIMEOUT_MS` | 5000 | Per-batch POST timeout |

The endpoint has no auth unless `METRICS_TOKEN` is set. On a public-facing box,
set the token or bind the scrape behind the reverse proxy.

## What ships out of the box

- `xchain_service_info{service,version,coin,network,node_version}`
- `process_start_time_seconds`, `process_uptime_seconds`,
  `process_resident_memory_bytes`, `process_cpu_user_seconds_total`,
  `process_cpu_system_seconds_total`
- `nodejs_heap_size_used_bytes`, `nodejs_heap_size_total_bytes`,
  `nodejs_external_memory_bytes`, `nodejs_active_handles_total`
- `http_requests_total{method,route,status}`,
  `http_request_duration_seconds{method,route}`, `http_requests_in_flight`
- `log_lines_emitted_total{level}`, `log_lines_shipped_total`,
  `log_lines_dropped_total`, `log_ship_failures_total`, `log_ship_buffer_lines`
- `xchain_metrics_series_dropped_total{metric}` (cardinality guard tripped)

## Adding a service metric

```js
if (observability.registry) {
    const height = observability.registry.gauge({
        name: 'xchain_indexer_block_height',
        help: 'Last block height the indexer committed'
    });
    height.set({}, block.height);
}
```

Label names are fixed at declaration; a metric can never grow a label at
runtime, and each metric caps distinct label-value series at 500 (excess
observations are dropped and counted, never buffered).

## Not in scope

Alerting and watchdogs, and the actual fleet rollout of a
Prometheus server and a log collector, which is an ops step.
