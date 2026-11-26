using System.Text;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// Observable behavior every <see cref="IAgentFileStore"/> shares: exact bytes, ordinal
/// listings with implicit directories, conditional writes, delete, rename and mkdir, and the
/// path rules of <see cref="AgentFilePaths"/> (the §11 traversal cases). File-only rules
/// (locators, links) stay in <see cref="AgentFilesTests"/>; the hosted store's own rules
/// (blobs, limits, fencing, tenants) are in <see cref="PostgresAgentFilesTests"/>.
/// </summary>
public abstract class AgentFilesContractTests
{
    private protected abstract Task<StoreUnderTest> CreateAsync();

    private protected sealed class StoreUnderTest(
        IAgentFileStore files,
        Func<string, Task> createAgent,
        Func<ValueTask> dispose
    ) : IAsyncDisposable
    {
        internal IAgentFileStore Files { get; } = files;

        internal Task CreateAgentAsync(string name) => createAgent(name);

        public ValueTask DisposeAsync() => dispose();
    }

    private static readonly CancellationToken None = CancellationToken.None;

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);

    private async Task<StoreUnderTest> WithAgentAsync(string name = "alpha")
    {
        var store = await CreateAsync();
        await store.CreateAgentAsync(name);
        return store;
    }

    [Fact]
    public async Task Writes_read_back_exactly_with_a_generation()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        var content = new byte[] { 0xEF, 0xBB, 0xBF, (byte)'h', (byte)'i', 0, 0xFF };
        var generation = await files.WriteAsync("alpha", "docs/notes.bin", content, null, None);
        Assert.NotEqual(0, generation);
        var read = await files.ReadAsync("alpha", "docs/notes.bin", None);
        Assert.Equal(content, read.Bytes);
        Assert.Equal(generation, read.Generation);
        var stat = files.Stat("alpha", "docs/notes.bin")!;
        Assert.False(stat.IsDirectory);
        Assert.Equal(content.Length, stat.Length);
        Assert.Equal(generation, stat.Generation);
        Assert.True(files.FileExists("alpha", "docs/notes.bin"));
        Assert.False(files.FileExists("alpha", "docs"));
        Assert.True(files.Stat("alpha", "docs")!.IsDirectory);
        Assert.Null(files.Stat("alpha", "docs/none"));
        Assert.Null(files.Stat("alpha", "docs/notes.bin/below"));
        await Assert.ThrowsAsync<FileNotFoundException>(() => files.ReadAsync("alpha", "docs/none", None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.ReadAsync("alpha", "docs", None));
        // Text reads decode like File.ReadAllText: UTF-8, the byte order mark dropped.
        await files.WriteAsync("alpha", "memory/A.md", Bytes("\uFEFFGrüße 🦊\n"), null, None);
        Assert.Equal("Grüße 🦊\n", await files.ReadTextAsync("alpha", "memory/A.md", None));
        await files.WriteAsync("alpha", "memory/empty.md", Array.Empty<byte>(), null, None);
        Assert.Empty((await files.ReadAsync("alpha", "memory/empty.md", None)).Bytes);
        Assert.Equal(0, files.Stat("alpha", "memory/empty.md")!.Length);
    }

    [Fact]
    public async Task Listings_are_ordinal_with_implicit_directories()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        foreach (var path in new[] { "docs/b.md", "docs/a.md", "docs/sub/deep/c.md", "docs/Z.md", "docs/é.md", "docs/c.txt" })
            await files.WriteAsync("alpha", path, Bytes(path), null, None);
        var entries = files.List("alpha", "docs");
        Assert.Equal(["Z.md", "a.md", "b.md", "c.txt", "sub", "é.md"], entries.Select(entry => entry.Name));
        Assert.True(entries.Single(entry => entry.Name == "sub").IsDirectory);
        Assert.Null(entries.Single(entry => entry.Name == "sub").Length);
        Assert.Equal("docs/a.md".Length, entries.Single(entry => entry.Name == "a.md").Length);
        Assert.NotNull(entries.Single(entry => entry.Name == "a.md").LastWriteUtc);
        Assert.All(entries, entry => Assert.False(entry.IsLink));
        Assert.Equal(["Z.md", "a.md", "b.md", "é.md"], files.List("alpha", "docs", "*.md").Select(entry => entry.Name));
        Assert.Equal(["c.md"], files.List("alpha", "docs/sub/deep").Select(entry => entry.Name));
        Assert.Contains("docs", files.List("alpha", "").Select(entry => entry.Name));
        Assert.Empty(files.List("alpha", "missing"));
        // Same calls, same answer.
        Assert.Equal(
            entries.Select(entry => (entry.Name, entry.Locator, entry.IsDirectory, entry.Length)),
            files.List("alpha", "docs").Select(entry => (entry.Name, entry.Locator, entry.IsDirectory, entry.Length))
        );
    }

    [Fact]
    public async Task Conditional_writes_compare_the_generation_read()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        var first = await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("one"), 0, None);
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("again"), 0, None)
        );
        var second = await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("two"), first, None);
        Assert.NotEqual(first, second);
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("stale"), first, None)
        );
        Assert.Equal("two", await files.ReadTextAsync("alpha", "memory/MEMORY.md", None));
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            files.WriteAsync("alpha", "memory/absent.md", Bytes("x"), second, None)
        );
        Assert.Null(files.Stat("alpha", "memory/absent.md"));
        var third = await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("three"), null, None);
        Assert.Equal(third, (await files.ReadAsync("alpha", "memory/MEMORY.md", None)).Generation);
    }

    [Fact]
    public async Task Concurrent_writes_with_one_read_generation_admit_exactly_one()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        var read = await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("base"), null, None);
        var attempts = Enumerable
            .Range(0, 6)
            .Select(index => Task.Run(async () =>
            {
                try
                {
                    await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("edit " + index), read, None);
                    return true;
                }
                catch (AgentFileConflictException)
                {
                    return false;
                }
            }))
            .ToArray();
        Assert.Equal(1, (await Task.WhenAll(attempts)).Count(won => won));
    }

    [Fact]
    public async Task Deletes_remove_files_and_trees_and_keep_the_parent()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        var generation = await files.WriteAsync("alpha", "docs/only.md", Bytes("x"), null, None);
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            files.DeleteAsync("alpha", "docs/only.md", false, generation + 2, None)
        );
        await files.DeleteAsync("alpha", "docs/only.md", false, generation, None);
        Assert.Null(files.Stat("alpha", "docs/only.md"));
        Assert.True(files.Stat("alpha", "docs")!.IsDirectory);
        Assert.Empty(files.List("alpha", "docs"));
        await Assert.ThrowsAsync<FileNotFoundException>(() => files.DeleteAsync("alpha", "docs/only.md", false, null, None));
        await files.WriteAsync("alpha", "docs/tree/a.md", Bytes("a"), null, None);
        await files.WriteAsync("alpha", "docs/tree/b/c.md", Bytes("c"), null, None);
        await Assert.ThrowsAnyAsync<IOException>(() => files.DeleteAsync("alpha", "docs/tree", false, null, None));
        Assert.True(files.FileExists("alpha", "docs/tree/b/c.md"));
        await files.DeleteAsync("alpha", "docs/tree", true, null, None);
        Assert.Null(files.Stat("alpha", "docs/tree"));
        Assert.Null(files.Stat("alpha", "docs/tree/b/c.md"));
        Assert.True(files.Stat("alpha", "docs")!.IsDirectory);
        await files.DeleteAsync("alpha", "docs", false, null, None);
        Assert.Null(files.Stat("alpha", "docs"));
        await Assert.ThrowsAnyAsync<IOException>(() => files.DeleteAsync("alpha", "", true, null, None));
        Assert.True(files.Stat("alpha", "")!.IsDirectory);
    }

    [Fact]
    public async Task Renames_move_files_and_directories()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        var generation = await files.WriteAsync("alpha", "docs/a.md", Bytes("a"), null, None);
        await files.WriteAsync("alpha", "docs/b.md", Bytes("b"), null, None);
        await files.RenameAsync("alpha", "docs/a.md", "archive/2026/a.md", false, None);
        Assert.Null(files.Stat("alpha", "docs/a.md"));
        Assert.Equal("a", await files.ReadTextAsync("alpha", "archive/2026/a.md", None));
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            files.RenameAsync("alpha", "docs/b.md", "archive/2026/a.md", false, None)
        );
        await files.RenameAsync("alpha", "docs/b.md", "archive/2026/a.md", true, None);
        Assert.Equal("b", await files.ReadTextAsync("alpha", "archive/2026/a.md", None));
        // The source's directory stays, as on a file system.
        Assert.True(files.Stat("alpha", "docs")!.IsDirectory);
        await files.WriteAsync("alpha", "archive/2026/sub/c.md", Bytes("c"), null, None);
        await files.RenameAsync("alpha", "archive", "old", false, None);
        Assert.Null(files.Stat("alpha", "archive"));
        Assert.Equal("c", await files.ReadTextAsync("alpha", "old/2026/sub/c.md", None));
        Assert.Equal(["2026"], files.List("alpha", "old").Select(entry => entry.Name));
        await Assert.ThrowsAnyAsync<IOException>(() => files.RenameAsync("alpha", "old", "old/2026/inner", false, None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.RenameAsync("alpha", "old/2026/sub/c.md", "old/2026", true, None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.RenameAsync("alpha", "old", "docs", false, None));
        await Assert.ThrowsAsync<FileNotFoundException>(() => files.RenameAsync("alpha", "none", "other", false, None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.RenameAsync("alpha", "old", "", false, None));
        _ = generation;
    }

    [Fact]
    public async Task Directories_are_made_kept_and_checked()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        await files.MakeDirectoryAsync("alpha", "skills/new/scripts", None);
        Assert.True(files.Stat("alpha", "skills/new/scripts")!.IsDirectory);
        Assert.Equal(["scripts"], files.List("alpha", "skills/new").Select(entry => entry.Name));
        await files.MakeDirectoryAsync("alpha", "skills/new/scripts", None);
        await files.WriteAsync("alpha", "skills/new/scripts/run.py", Bytes("print()"), null, None);
        await files.DeleteAsync("alpha", "skills/new/scripts/run.py", false, null, None);
        Assert.True(files.Stat("alpha", "skills/new/scripts")!.IsDirectory);
        await files.WriteAsync("alpha", "skills/file", Bytes("x"), null, None);
        await Assert.ThrowsAnyAsync<IOException>(() => files.MakeDirectoryAsync("alpha", "skills/file", None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.MakeDirectoryAsync("alpha", "skills/file/below", None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.WriteAsync("alpha", "skills/file/below.md", Bytes("x"), null, None));
        await Assert.ThrowsAnyAsync<IOException>(() => files.WriteAsync("alpha", "skills/new", Bytes("x"), null, None));
        Assert.Equal("x", await files.ReadTextAsync("alpha", "skills/file", None));
    }

    [Fact]
    public async Task Agents_are_separate_and_must_exist()
    {
        await using var store = await WithAgentAsync();
        await store.CreateAgentAsync("beta");
        var files = store.Files;
        await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("alpha"), null, None);
        Assert.Null(files.Stat("beta", "memory/MEMORY.md"));
        await files.WriteAsync("beta", "memory/MEMORY.md", Bytes("beta"), null, None);
        Assert.Equal("alpha", await files.ReadTextAsync("alpha", "memory/MEMORY.md", None));
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            files.WriteAsync("gamma", "memory/MEMORY.md", Bytes("x"), null, None)
        );
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() => files.MakeDirectoryAsync("gamma", "docs", None));
        await Assert.ThrowsAnyAsync<Exception>(() => files.WriteAsync("../beta", "memory/MEMORY.md", Bytes("x"), null, None));
        Assert.Equal("beta", await files.ReadTextAsync("beta", "memory/MEMORY.md", None));
    }

    [Fact]
    public async Task The_installation_level_holds_prompt_files()
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        await files.WriteAsync(null, "00_SYSTEM.local.md", Bytes("local"), null, None);
        Assert.True(files.FileExists(null, "00_SYSTEM.local.md"));
        Assert.Equal("local", await files.ReadTextAsync(null, "00_SYSTEM.local.md", None));
        Assert.Null(files.Stat("alpha", "00_SYSTEM.local.md"));
    }

    public static TheoryData<string> InvalidPaths() =>
        new()
        {
            "../beta/memory/MEMORY.md",
            "memory/../../beta/x",
            "memory/./MEMORY.md",
            "/etc/passwd",
            "//server/share",
            "memory//MEMORY.md",
            "memory/",
            "memory/MEMORY.md\0.txt",
            "memory\\..\\x",
            "memory/line\nbreak.md",
            "memory/Cafe\u0301.md", // decomposed é: not normalization form C
            new string('a', 256),
            string.Join('/', Enumerable.Repeat(new string('a', 200), 21)),
        };

    [Theory]
    [MemberData(nameof(InvalidPaths))]
    public async Task Paths_outside_the_store_syntax_are_refused_by_every_operation(string path)
    {
        await using var store = await WithAgentAsync();
        var files = store.Files;
        await files.WriteAsync("alpha", "memory/MEMORY.md", Bytes("kept"), null, None);
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.WriteAsync("alpha", path, Bytes("x"), null, None));
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.ReadAsync("alpha", path, None));
        Assert.Throws<AgentFilePathException>(() => files.Stat("alpha", path));
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.DeleteAsync("alpha", path, true, null, None));
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.MakeDirectoryAsync("alpha", path, None));
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.RenameAsync("alpha", "memory/MEMORY.md", path, true, None));
        await Assert.ThrowsAsync<AgentFilePathException>(() => files.RenameAsync("alpha", path, "memory/other.md", true, None));
        Assert.Equal("kept", await files.ReadTextAsync("alpha", "memory/MEMORY.md", None));
    }

    [Fact]
    public async Task A_path_that_is_not_valid_Unicode_is_refused()
    {
        await using var store = await WithAgentAsync();
        await Assert.ThrowsAsync<AgentFilePathException>(() =>
            store.Files.WriteAsync("alpha", "memory/\uD800.md", Bytes("x"), null, None)
        );
        Assert.Throws<AgentFilePathException>(() => store.Files.Stat("alpha", "memory/\uDC00x"));
    }

    [Fact]
    public async Task Lookalike_names_are_names_not_traversal()
    {
        await using var store = await WithAgentAsync();
        await store.CreateAgentAsync("beta");
        var files = store.Files;
        // Fullwidth dots and the two-dot leader only become ".." under compatibility
        // normalization, which the store never applies.
        foreach (var name in new[] { "\uFF0E\uFF0E", "\u2025", "...", ".hidden", "café.md" })
            await files.WriteAsync("alpha", name + "/x.md", Bytes(name), null, None);
        Assert.Equal(
            new[] { "...", ".hidden", "café.md", "\u2025", "\uFF0E\uFF0E" }.Order(StringComparer.Ordinal),
            files.List("alpha", "").Select(entry => entry.Name).Where(name => name is not "memory")
        );
        Assert.Empty(files.List("beta", "").Where(entry => entry.Name != "memory"));
    }
}

public sealed class FileAgentFilesContractTests : AgentFilesContractTests
{
    private protected override Task<StoreUnderTest> CreateAsync()
    {
        var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work, canonicalLayout: true);
        return Task.FromResult(
            new StoreUnderTest(
                new FileAgentFiles(agents),
                name => agents.CreateAsync(name),
                () =>
                {
                    temp.Dispose();
                    return ValueTask.CompletedTask;
                }
            )
        );
    }

    [Fact]
    public async Task Writes_never_pass_through_a_symbolic_link()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        var outside = Path.Combine(temp.Path, "outside");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(outside);
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work, canonicalLayout: true);
        await agents.CreateAsync("alpha");
        Directory.CreateSymbolicLink(Path.Combine(agents.AgentDirectory("alpha"), "docs"), outside);
        var files = new FileAgentFiles(agents);
        await Assert.ThrowsAnyAsync<IOException>(() =>
            files.WriteAsync("alpha", "docs/escape.md", "x"u8.ToArray(), null, CancellationToken.None)
        );
        await Assert.ThrowsAnyAsync<IOException>(() => files.DeleteAsync("alpha", "docs", true, null, CancellationToken.None));
        Assert.Empty(Directory.EnumerateFileSystemEntries(outside));
    }
}

[Trait("Backend", "postgres")]
public sealed class PostgresAgentFilesContractTests : AgentFilesContractTests
{
    private protected override async Task<StoreUnderTest> CreateAsync()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        var store = PostgresAgentFilesTests.Store(tenant);
        return new StoreUnderTest(
            store,
            name => store.CreateAgentAsync(name, ["memory"], [], CancellationToken.None),
            database.DisposeAsync
        );
    }
}
