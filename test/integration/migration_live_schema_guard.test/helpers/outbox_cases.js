'use strict';

const method = 'assertPendingHubPushPayloadIsWide';

module.exports = { assertions: [
    {
        name: 'outbox payload remains TEXT utf8mb3',
        method,
        refuses: /pending_hub_pushes\.payload is text with utf8mb3[\s\S]*--file 2026-11-19-pending-hub-pushes-widen-payload\.sql/,
        ddl: ['CREATE TABLE pending_hub_pushes (payload TEXT CHARACTER SET utf8 NOT NULL)']
    },
    {
        name: 'outbox payload is MEDIUMTEXT utf8mb4',
        method,
        refuses: undefined,
        ddl: ['CREATE TABLE pending_hub_pushes (payload MEDIUMTEXT CHARACTER SET utf8mb4 NOT NULL)']
    }
] };
