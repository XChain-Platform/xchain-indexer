# Pinned to node:22-bookworm: xchain-vm's isolated-vm native build fails
# against Node 26+ V8 headers (same Node-version pin as xchain-utxo-tracker).
FROM node:22-bookworm

RUN mkdir /XChainIndexer/
# xchain-vm is staged into the build context by xchain-node's install path
# (LIBRARY_BUNDLES); the file: link in package.json resolves it at npm install.
COPY ./xchain-vm /XChainIndexer/xchain-vm
COPY ./package.json /XChainIndexer/package.json
WORKDIR /XChainIndexer
RUN npm install

COPY ./src /XChainIndexer/src
COPY ./.en[v] /XChainIndexer/.env

CMD ["npm", "run", "api"]