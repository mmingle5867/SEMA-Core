# Foundation policy transition

SEMA Core v0.2.7 replaces anonymous loopback administration with two separate
checks:

1. an application presents its registered application key and a private
   service credential; and
2. Foundation Access allows that registered application to perform the exact
   requested Core operation.

The credential is authentication only. It is not a user identity and must not
be recorded as the person who initiated an application command.

## Required Core settings

```dotenv
SEMA_FOUNDATION_ACCESS_URL=http://127.0.0.1:4340
SEMA_POLICY_KEY=<same private value as Foundation Access policy key>
SEMA_APPLICATION_CLIENTS_JSON=[{"applicationKey":"sema.foundation.access","secret":"<foundation-access-secret>"},{"applicationKey":"vectorforge","secret":"<vectorforge-secret>"}]
```

Keep these values local. Never put the secrets in an application manifest,
source package, or published configuration file.

## Required Foundation grants

Create grants only after the application records exist. For this initial
transition, grant `sema.foundation.access`:

- `core.identifiers.reserve`
- `core.identifiers.consume`
- `core.audits.record`

Grant `vectorforge` only the Core operations it currently needs:

- `core.identifiers.reserve`
- `core.identifiers.consume`
- `core.commands.*`
- `core.executions.*`
- `core.events.record`
- `core.audits.record`
- `core.capabilities.*`
- `core.health.read`
- `core.statistics.read`

These are Core operations only. They grant no resource, workspace, ListingForge,
or Resource Facility access.

## Safe rollout order

1. Install Foundation Access v0.1.2 and add `SEMA_POLICY_KEY`.
   Do not set its Core application secret yet.
2. Install VectorForge v0.71.3. Leave its application secret empty.
3. Create the two Foundation grants above.
4. Add the two application secrets to Foundation Access, VectorForge, and the
   Core client registry. Add the same policy key to Core and restart Core last.
5. Verify Foundation Access can create a test organization and VectorForge can
   perform a normal local operation. Then remove the test organization if it
   was only used for verification.

Once Core is configured with a Foundation URL and policy key, requests without
a valid application credential are rejected.
