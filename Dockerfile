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