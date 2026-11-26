# Unit: Hosted Agent store

Files: `dotnet/Foxwarm/Hosted/Postgres/AgentFiles/PgAgentFileStore.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.AgentFiles.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/1100_agent_files.sql`, `dotnet/Foxwarm/Sessions/AgentFilePaths.cs`, `dotnet/Foxwarm.Tests/Storage/AgentFilesContractTests.cs`, `dotnet/Foxwarm.Tests/Storage/PostgresAgentFilesTests.cs`
Secondary files: `dotnet/Foxwarm/Sessions/AgentFiles.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Blobs.cs`, `dotnet/Foxwarm/Storage/StorageContext.cs`, `dotnet/Foxwarm.Tests/Storage/S3BlobStoreTests.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedTestBackend.cs`

## Purpose

In hosted mode a tenant's Agent files (memory, docs, skills and other small durable files, plus the installation prompt files beside the Agent folders) live in the tenant's database and blob store instead of a directory (design U4(a), plan §5). This unit owns the store: its table, the write half of [`IAgentFileStore`](./storage-context.md#agent-files) on both implementations, its path rules and its limits. File mode keeps the Agent folders and doesn't change.

## D-agent-store-representation

**Approved plan §5.1, with the membership row decided by the coordinator (2026-11-27).**

- **Rows.** `agent_files(tenant_id, agent, path, kind, size, sha256, generation, inline, blob_key, mode_flags, updated_at)`, primary key `(tenant_id, agent, path)`, text keys in `COLLATE "C"`. `agent` is the Agent name, or `''` for the installation level (`IAgentFileStore`'s null Agent); no Agent name is empty.
- **Directories** are implicit in file paths. A `dir` row exists only for an empty directory, and every write keeps it that way: creating an entry below a directory removes the directory's own row, and removing the last entry of a directory adds one, so a directory stays when its contents go, as on a file system.
- **Membership.** Each existing Agent has a root row: `kind = 'dir'`, `path = ''`. An Agent exists exactly when its root row does, which is file mode's rule (an Agent exists when its directory does). The `Agents` state document stays metadata keyed by name; command deletion deliberately keeps a deleted Agent's metadata there, so its keys aren't the member list. Only the lifecycle operations (`CreateAgentAsync`, `DeleteAgentAsync`) write root rows, each in one transaction with the Agent's files.
- **Content.** Up to 256 KiB (`InlineBytes`) is inline. Larger content is a blob of the tenant's `agent-files` blob store (PostgreSQL or S3, as the deployment selects for images and artifacts) under `<agent>/<sha256>` (`.root/<sha256>` for the installation level), created before the transaction that references it. Blobs are content-addressed and created with keep-existing, so identical content shares one. Nothing deletes them: unreferenced blobs are collected in P3 with the backup window rule, as for the other blob stores ([hosted blobs](./hosted-blobs.md#d-hosted-blob-unfenced-writes)). A read verifies length and SHA-256 against the row.
- **Not representable:** symbolic links, executable bits and special files. `mode_flags` stays 0. Import reports what it can't represent.
- **Locators** are `agents/<agent>/<path>` (`agents/<path>` for the installation level), stable for unchanged rows. A hosted prompt shows no memory paths ([capability profile](./hosted-capabilities.md#d-capability-without-master)).

## D-agent-store-paths

**Derived from plan §11 (the traversal suite).** `AgentFilePaths` is the path syntax of both implementations' write half and of every hosted operation:

- relative and `/`-separated: no leading `/`, no backslash, no empty, `.` or `..` segment;
- no control character, NUL included;
- valid UTF-16 (no lone surrogate), at most 255 UTF-8 bytes per segment and 4,096 in total;
- in Unicode normalization form C. A path is stored exactly as given and nothing applies compatibility normalization, so two spellings can't name two files and no later normalization can turn a stored name into `..` (fullwidth dots and the two-dot leader stay plain names).

The empty path is the Agent's own directory: it can be listed and statted, never removed or renamed. An invalid path is `AgentFilePathException` (an `ArgumentException`) and has no effect. Agent names pass `AgentCatalog.ValidateName`, so an Agent argument can't address another Agent's rows by path syntax. Authorization between Agents belongs to the consumers.

## D-agent-store-writes

**Approved plan §5.1.**

- **Operations** (`IAgentFileStore`): `WriteAsync` (create or replace, parents implicit), `DeleteAsync` (a file, an empty directory, or a tree with `recursive`), `RenameAsync` (within one Agent; a file may replace a file with `overwrite`; never into itself), `MakeDirectoryAsync` (with parents; an existing directory is kept). A missing file is `FileNotFoundException`, a missing Agent `DirectoryNotFoundException`, a type clash ("Is a directory", "Not a directory", "Directory not empty") `IOException`; both implementations use the same texts (`AgentFileErrors`).
- **Generations.** `expectedGeneration` null writes unconditionally, 0 requires the file to be absent, any other value requires that generation; otherwise `AgentFileConflictException`. In the hosted store every file write takes the next value of the tenant's counter in `agent_file_usage`, so a generation is never reused for a path, also after delete and recreate. A rename keeps the moved files' generations. `FileAgentFiles` reports a content hash (never 0) as the generation, which changes whenever the content does.
- **One write lane per Agent** (`AgentWriteLanes`) in each store instance. In the hosted store every write transaction first locks the tenant's `agent_file_usage` row, which also serializes writes across Agents of the tenant and makes the limit checks exact. Each write is one fenced `TenantDb.WriteAsync` transaction with a `Verify` for a lost `COMMIT`, retryable on serialization failure or deadlock; a write after an epoch bump fails with `TenantFencedException` and leaves no row.
- **Reads** are deterministic: listings in ordinal name order (both implementations), exact bytes, and text decoded as `File.ReadAllText` decodes it (UTF-8, a byte order mark dropped), so prompt building gets the same text from either store. Filtered listings match names as the platform matches file patterns (case-sensitive).
- **File implementation.** `FileAgentFiles`' write half writes a complete temporary file and renames it over the target, and refuses any path whose existing components below the Agent directory include a symbolic link.

## D-agent-store-limits

**Plan §7.2, defaults accepted by the coordinator (Q4).** `AgentStoreLimits(TotalBytes, Files, FileBytes)`, default 2 GiB, 20,000 and 64 MiB, is an input of the hosted store (`PostgresStorageContext.AgentStoreLimits`, read at every admission); per-tenant settings replace it later.

- `agent_file_usage(bytes, entries)` is maintained in each write transaction. `entries` counts files and empty-directory rows; root rows aren't counted.
- A file above `FileBytes` is refused before anything is written, its blob included. A write is refused with `AgentStoreQuotaException` (`Limit` = `fileBytes`, `totalBytes` or `files`) when it would grow a measured value past its limit. A write that doesn't grow the value is admitted, so a tenant over a lowered limit can still delete, shrink and rename.
- File mode has no Agent store limits.

## Tests

- `AgentFilesContractTests` (abstract) runs as `FileAgentFilesContractTests` and `PostgresAgentFilesContractTests`: exact bytes and text decoding, ordinal listings with implicit directories and patterns, conditional writes, concurrent writes with one read generation (exactly one wins), delete and parent retention, rename of files and trees, mkdir and type clashes, Agent separation and existence, the installation level, and the traversal cases (`..`, absolute paths, NUL and other controls, backslash, non-NFC and invalid Unicode, oversized segments and paths, lookalike dots) refused by every operation with nothing changed. The file subclass also refuses writes through a symbolic link.
- `PostgresAgentFilesTests`: inline and blob content at the 256 KiB boundary, blob reuse and digest verification, the lifecycle rows, usage equal to the rows after every kind of write, generations not reused, each limit at admission and shrinking under a lowered limit, the fencing case for every write operation (nothing left behind), and tenant separation.
- `S3BlobStoreTests` checks that the context puts the `agent-files` blobs on the selected backend and rebuilds the store over them.
