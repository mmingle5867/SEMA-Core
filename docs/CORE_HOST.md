# SEMA Core Host

The Core Host is the backend around the portable SEMA Core rules. It is intentionally a separate runtime concern from application UIs and business workflows.

It owns installation-level settings, health, operational statistics, Core runtime access, and self-documentation. It does not own VectorForge artwork settings, graphics tools, ListingForge listings, pricing rules, or application user interfaces.

Initial local API endpoints:

- `GET /v1/core/health`
- `GET /v1/core/settings`
- `PUT /v1/core/settings`
- `GET /v1/core/statistics`
- `GET /v1/core/capabilities`
- `GET /v1/core/documentation`

The reference host uses an in-memory store for tests. A PostgreSQL/Prisma host store is the next adapter and is the path VectorForge will use. That adapter will store settings and statistics inputs alongside Core records, never in VectorForge-specific tables.
