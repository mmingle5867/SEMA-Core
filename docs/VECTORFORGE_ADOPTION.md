# VectorForge adoption plan

## Purpose

VectorForge is the first application to use SEMA Core. Its current embedded services proved the data model, but future applications must not copy them.

## Database ownership

VectorForge already has the Core tables in its PostgreSQL database. It will keep those records in place.

The adoption migration will:

1. Add `sema_identifier_reservations`.
2. Add `reservationId`, `status`, and `consumedAt` to `sema_issued_identifiers`.
3. Backfill every existing identifier as `ISSUED` in a synthetic historical reservation.
4. Keep the existing IDs unchanged; no mapping table or legacy lookup is introduced.

## Code ownership

VectorForge will replace its embedded `sema-id`, `sema-core-identity`, and `sema-core` services with an adapter implementing `SemaCoreStore` from `@selo/sema-core`.

- Identity issuance, reservations, commands, executions, results, events, audits, and capability resolution then use the independent Core package.
- VectorForge retains only VectorForge-specific commands and metadata.
- Graphics remains a VectorForge capability provider, not a Core feature.

## Safety boundary

The adoption is a separate migration slice. It must run only after a database backup, must preserve the current Core installation `3`, and must validate that the existing issued ledger count and IDs are unchanged after migration.
