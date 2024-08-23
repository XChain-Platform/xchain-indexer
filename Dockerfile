FROM node:latest

RUN mkdir /XChainIndexer/
COPY ./package.json /XChainIndexer/package.json
WORKDIR /XChainIndexer
RUN npm install

COPY ./src /XChainIndexer/src
COPY ./.en[v] /XChainIndexer/.env

CMD ["npm", "run", "api"]