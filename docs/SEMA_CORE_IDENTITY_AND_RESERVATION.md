# SEMA Core Identity and Reservation Model

## Canonical KeyID

A SEMA KeyID is a variable-length, Base56, hyphen-delimited allocation path.
The hyphen is required and is part of the identity.

- A top-level installation receives its InstallationID from its governing parent.
- A child installation uses the parent’s next normal object ID as its InstallationID.
- The child’s first object ID appends its first LocalID to that InstallationID.

Example:

- Parent issues `b-A-3` for a child installation.
- The child’s InstallationID is `b-A-3`.
- Its first object ID is `b-A-3-3`.

The identifier grows only when allocation hierarchy requires it. It has no fixed length.

## Base56 alphabet

`234567890ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz`

The LocalID zero value is reserved. The first issued LocalID therefore encodes as `3`.

## Type codes

Type codes are optional human-readable metadata, for example `ART`, `COMMAND`, or `CAPABILITY`. They are never embedded in the KeyID and do not determine uniqueness.

## ID reservations

Core can atomically reserve a configurable block of one or more permanent IDs.

- The Core policy supplies the maximum reservation size.
- Reserved identifiers are entered in the immutable issued-ID ledger immediately.
- A service later consumes a specific reserved ID for its object.
- A reserved but unused ID remains permanently reserved. It is never reclaimed or reused.

This reduces allocator locks for high-throughput services without sacrificing uniqueness.
