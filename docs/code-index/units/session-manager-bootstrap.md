# Unit: Session manager bootstrap, admission, and catalog publication

Files: `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Bootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Admission.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Catalog.cs`

## Purpose

Builds the Main Session manager, initializes identity/catalog/archive services, admits exact Session lifetimes, and publishes owners only after authority recovery succeeds.

## Stable methods and callers

`LoadMainHostAsync` orders identity evidence/catalog initialization/owner loading; admission resolves identity, calls `PersistentSessionAuthorityStore.LoadAsync`, distinguishes null store result from cataloged missing-authority, applies `RecoverBusySnapshot`, strict-saves recovery, then publishes the owner. Catalog helpers expose Main identity/topology/presentation query/publication callbacks; presentation changes keep live parent fields aligned with the Main catalog before owner state notifications.

## Contract and side effects

The constructed manager pins independent journal and Archive data-root writers without opening their connections before startup evidence validation. Shutdown stops/drains producers and ordered Session saves before releasing those owners; accepted work resolves before connection closure. Disposal also awaits the idempotent shutdown path.

Stale busy recovery clears busy fields and stopping, adds one deduplicated resume event, saves strictly, and only then publishes. Stopping-only admission rejects. The catalog cannot reconstruct semantic JSON history or authorize a missing registered lifetime.

Admitted owners publish bounded local list projections on owner state/message events. Agent binding clear also recaptures affected admitted owners before topology invalidation, because effective placement can change without a Session authority mutation. It does not admit cold catalog members or rewrite retained selection/cwd.

## Tests

`SessionAdmissionTests.cs`; `SessionIdentityRecoveryTests.cs`; `SessionCatalogPublicationTests.cs`; startup/bootstrap tests.
