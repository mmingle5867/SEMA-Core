# SEMA Core

SEMA Core is a small, local-first TypeScript package that owns the cross-application rules for identity, commands, executions, results, events, audit records, policy decisions, and capability resolution.

It contains no VectorForge, ListingForge, pricing, marketplace, raster, or vectorization logic.

## Current scope

- Variable-length Base56 KeyIDs with required hyphen-delimited allocation paths
- Configurable, permanent identifier reservations
- Command lifecycle: pending, running, waiting, cancelled, failed, success
- Immutable result and event records
- Audit records
- Local capability registration, discovery, authorization, and resolution
- Storage-port architecture so PostgreSQL/Prisma, SQLite, and later remote adapters can share the same Core API

## Repository structure

- `src/identity`: canonical KeyID encoding and parsing
- `src/core`: Core API and persistence port
- `src/stores`: reference in-memory adapter used for tests
- `prisma`: PostgreSQL/Prisma persistence contract and initial migration
- `docs`: identity and reservation model

VectorForge is the first consumer, but this repository is intentionally application-independent.
