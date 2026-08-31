# Pinned to node:22-bookworm: xchain-vm's isolated-vm native build fails
# against Node 26+ V8 headers (same Node-version pin as xchain-utxo-tracker).
FROM node:22-bookworm

RUN mkdir /XChainIndexer/
# xchain-vm is staged into the build context by xchain-node's install path
# (LIBRARY_BUNDLES); the file: link in package.json resolves it at npm install.
COPY ./xchain-vm /XChainIndexer/xchain-vm
COPY ./package.json /XChainIndexer/package.json
COPY ./package-lock.json /XChainIndexer/package-lock.json
WORKDIR /XChainIndexer
RUN npm ci

COPY ./src /XChainIndexer/src
# Genesis-ledger bootstrap artifacts (Counterparty/Dogeparty name-ownership
# manifests + precomputed mainnet state dumps). config.js resolves
# GENESIS_LEDGER_PATH / GENESIS_DUMP_PATH under /XChainIndexer/data/genesis, so
# the bundled CSVs and dumps must ship inside the image; without this a
# containerized indexer crash-loops at the genesis block on a missing-file read
# (the direct-node self-tests passed only because data/ is on disk in the repo).
COPY ./data/genesis /XChainIndexer/data/genesis

# The vendored action manifest is RUNTIME data despite living under test/. The
# getrollcallsigners federation read reports its sha256 so a BTC indexer can tell
# a DOGE peer running a decoder that predates an action's allowlist entry, which
# would silently drop every instance of it, from a peer that genuinely has none
# to report. Without this line that read answers a null hash, the asking side's
# fail-closed manifest check can never match, and every roll-call epoch close
# defers forever behind a container that looks perfectly healthy. Measured on the
# regtest DOGE indexer before this landed: manifest_hash null, file absent.
# It stays the test/fixtures path rather than gaining a src/ twin because the
# platform's sync-action-manifest.sh already keeps this exact copy byte-identical
# to canonical in every consumer; a second copy would be a new drift surface that
# script does not know about.
COPY ./test/fixtures/action-manifest.json /XChainIndexer/test/fixtures/action-manifest.json
COPY ./.en[v] /XChainIndexer/.env

# Exec-form node, not `npm run api`. npm builds an npm -> sh -c -> node tree and
# no wrapper forwards signals, so `docker stop` kills npm while node is never
# told anything (measured on the regtest encoder, xchain-encoder/Dockerfile).
# --no-node-snapshot is carried verbatim from the package.json `api` script;
# dropping it would surface as a startup failure, not as a shutdown bug.
# Dropping the npm wrapper also drops the npm_package_* env vars, which
# XChainIndexer.js reads for its boot banner; that read falls back to
# package.json for exactly this launch path.
CMD ["node", "--no-node-snapshot", "./src/api.js"]