# Core-to-Core conversations

A Core holds only its own machine node and the user nodes placed on that machine. Anything that involves
another machine is a conversation: the Core you ask runs the steps and reaches the others at the addresses
stored beside each parent pointer.

## Settings (Core `.env`)

| Setting | Meaning |
| --- | --- |
| `SEMA_CORE_ADDRESS` | The stable name other Cores use to reach this one, e.g. `http://neo-main:4310`. Stored beside every pointer to a node held here. Leave unset on a single-machine setup. |
| `SEMA_CORE_PEER_APPLICATION_KEY`, `SEMA_CORE_PEER_SECRET` | The shared application credential presented to other Cores. It must be registered in each Core's `SEMA_APPLICATION_CLIENTS_JSON`. Later replaced by per-machine keys. |

Without the peer credential a Core still works alone; the conversation routes answer that they are not configured.

## Routes (all need `core.topology.write`, except the two reads)

| Route | What it does |
| --- | --- |
| `GET /v1/core/topology/local` | The nodes this Core holds, each with `nextId` (the next ID it would issue: its basis plus the next number), and its own address. A retired node has no `nextId`. |
| `GET /v1/core/topology/walk-up?nodeId=&nodeAddress=` | Parents in turn; stops where a machine cannot be reached. |
| `POST /v1/core/topology/create` `{parentId, parentAddress?, type, newNodeAddress?}` | New node under a parent, here or on the Core at `newNodeAddress`. Installing a machine and adding a user are this. |
| `POST /v1/core/topology/insert-above` `{childId, childAddress?, type, newNodeAddress?}` | New node between a node and its parent. |
| `POST /v1/core/topology/add-parent-above` `{nodeId, nodeAddress?, type, newNodeAddress?, issuerId?, issuerAddress?}` | New parent above a node that has none, so the tree grows from the ground up. Needs `core.authority.add-top`, not `core.topology.write`. See below. |
| `POST /v1/core/topology/rehome` `{nodeId, nodeAddress?, newParentId, newParentAddress?, administratorOverride?}` | Move a node and its subtree. Only "under itself" is refused. |
| `POST /v1/core/topology/remove` `{nodeId, nodeAddress?, childrenParentId?}` | Retire; children follow the pointer later. |
| `POST /v1/core/topology/roll-up` `{nodeId, nodeAddress?, issuerId?}` | Shorter basis from the highest reachable ancestor. |
| `POST /v1/core/topology/repair-parent` `{nodeId, nodeAddress?}` | Point a node whose parent was retired at its nearest live ancestor. |

An address left out means "this Core". Each operation is audited by the Core that ran it.

## Node type

Every node has a `type`. Core lists only the types its own rules treat differently:

| Type | What it is | Takes a seat |
| --- | --- | --- |
| `ORGANIZATION` | A company, with its own keyholders and its own seat limits. | No |
| `GROUP` | A grouping inside one: department, site, network. | No |
| `USER` | A person. | Yes, a user seat |
| `MACHINE` | A PC or device. | Yes, a machine seat |

Finer detail (laptop, printer, sales department) is a description kept by Foundation Access.

The type is named when the node is created and recorded once, by the Core that holds the node. A create or insert without it is refused before any number is issued. Nothing changes it afterwards: not a rehome, a roll-up or a removal. A different type is a new node with a new ID.

A machine's own node is a `MACHINE`. Seat limits are not built yet.

## Adding a parent above a top node

A top node has no parent to issue the new node's ID, so another node issues it: its basis plus the next number from its counter. The new node is not the issuer's child, so the issuer's count does not change. The new node has no parent and a child count of 1, and the old top points to it.

The issuer is the node named in `issuerId`. When none is named, it is the node with the shortest basis among the top node itself and the active nodes held by the Core that runs the request. A shorter basis keeps the new ID short; any counter gives a unique value, so the choice never affects uniqueness. On the first machine that is node `3`, so every top is `3` plus one number.

This is a change at the top of the tree. It has its own permission, `core.authority.add-top`, which a grant of `core.topology.*` does not cover. Nobody holds it by default: it is granted by hand for the one occasion and removed afterwards, until keyholder signatures replace it.

## Testing the PostgreSQL stores

`npm test` uses the in-memory stores. `npm run test:postgres` runs the node store and Core's start-up against a real database: set `SEMA_CORE_TEST_DATABASE_URL` to an empty, migrated database that is not the live one. Without it the test is skipped.
