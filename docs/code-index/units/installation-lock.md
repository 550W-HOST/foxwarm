# Unit: Installation lock

Files: `dotnet/Foxwarm/InstallationLock.cs`, `dotnet/Foxwarm.Tests/InstallationLockTests.cs`
Secondary files: `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/CliCommands.cs`, `dotnet/Foxwarm/MainLog.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.Local.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.Local.cs`, `scripts/main.js`, `scripts/main.test.js`

## Purpose

Ensures that at most one Main process uses a data directory. Without it, two Mains started on the same `FOXWARM_DATA_DIR` or `data_dir` pointer would each write Session authority, the catalog, the Archive and the configuration documents. `SqliteWriterOwners` deduplicates writers only within one process.

## D-installation-lock

**Derived design for the file-mode data root; hosted mode uses leases instead.** One process holds the data directory. A second one fails at entry instead of waiting, and the operating system, not Foxwarm, releases the hold.

[2026-11-26] `InstallationLock.Acquire(dataRoot)` opens `<data>/state/main.lock` with `FileShare.None`. On Unix, .NET implements that as `flock(LOCK_EX|LOCK_NB)`; on Windows it's an exclusive share mode. The holder writes its PID and a newline for diagnostics only; the operating-system lock is the guard. The file is never deleted, because deleting it would race a new holder's open. Any process exit releases the lock, including SIGKILL and crashes, so there is no stale-lock recovery. .NET opens files close-on-exec, so the Vector child, Monty workers, independent exec helpers, PTY shells and other children don't inherit the lock, and an exec helper that outlives Main doesn't block the next start. Setting `DOTNET_SYSTEM_IO_DISABLEFILELOCKING` turns the Unix lock off for the process; that is the .NET switch, not a Foxwarm option.

- **Held by:** the console entry (`Program.cs`), after the helper dispatches and before `ModelConfiguration` is constructed, for the whole process. The Desktop local instance holds it from the start of local Main until its `MainHost` is disposed, so stopping and restarting local Main within the app re-acquires it.
- **Not held by:** `--cli-model` and `--cli-archive` (supported beside a running Main), `--inspect-upgrade` (runs read-only beside Main during source builds), `--version`, the exec, Vector and terminal helpers, or tests that compose `MainHost` directly.
- **When held elsewhere:** the entry fails with `InstallationLockedException`. Main exits with code 1 and its fatal line names the data directory. On Unix, where the file can be read with ordinary tools, it also points to the recorded PID.
- **Controls:** source stop and restart, the Windows background service, and container restarts all wait for the previous Main to exit before starting another, so none of them meets a held lock. When a second foreground launch is refused, `scripts/main.js` restores the running Main's `foxwarm.pid` record instead of removing it ([source entry](./source-main-entry.md)).
- **Hosted mode** has no data root. Tenant leases and fencing replace this lock there (storage design, P1).

## Tests

`InstallationLockTests` covers refusal while held in the same process (flock is per open file description), release on dispose, independent data directories, and a child process that doesn't keep the lock. `scripts/main.test.js` ("a second Main on the same data directory …") starts real managed Main: a second launch exits 1 with the message while the first keeps running and keeps its PID record, and a SIGKILLed Main's lock is free for the next start.
