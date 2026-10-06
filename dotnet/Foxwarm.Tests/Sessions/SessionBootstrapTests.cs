using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Channels.WebUi;

namespace Foxwarm.Tests;

public sealed class SessionBootstrapTests
{
    private static ResponsesClientOptions Options => new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
    [Fact]
    public async Task Actual_source_event_wrapper_and_nonrouting_startup_snapshot_identity_match()
    {
        const string content = "  Original\r\n<unescaped event body> & quotes \" remain.\n";
        var wrapper = SessionBoundary.SessionEvent("onboot", "ONBOOT: " + content);
        var time = Regex.Match(wrapper, "time=\"([^\"]+)\"").Groups[1].Value;
        var app = new JsonObject { ["llm"] = new JsonObject { ["contextLimit"] = 20000, ["compactThresholdPercent"] = .85 } };
        var session = new JsonObject { ["model"] = "old-model", ["effort"] = "low", ["childModelDefault"] = "old-child", ["childEffortDefault"] = "max" };
        var input = new JsonObject { ["time"] = time, ["content"] = content, ["app"] = app.DeepClone(), ["session"] = session.DeepClone() };
        var repo = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT") ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(new ProcessStartInfo("node") { WorkingDirectory = repo, ArgumentList = { Path.Combine(repo, "dotnet", "onboot-fixture-ts.mjs") }, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
        await process.StandardInput.WriteAsync(input.ToJsonString()); process.StandardInput.Close(); var output = await process.StandardOutput.ReadToEndAsync(); var error = await process.StandardError.ReadToEndAsync(); await process.WaitForExitAsync(); Assert.True(process.ExitCode == 0, error); var expected = JsonNode.Parse(output)!;
        Assert.Equal(expected["wrapper"]!.GetValue<string>(), wrapper);
        var empty = HostModels.Parse(new JsonObject { ["providers"] = new JsonObject() }, app);
        var state = new SessionState("main"); var envelope = (JsonObject)state.AuthorityEnvelope.DeepClone(); foreach (var (key, value) in session) envelope[key] = value?.DeepClone();
        var snapshot = state.Snapshot() with { AuthorityEnvelope = envelope };
        var dto = WebUiContract.Session(snapshot, empty, false, false); var presentation = expected["emptyPresentation"]!;
        foreach (var field in new[] { "model", "modelKey", "defaultModelKey", "childModelDefault", "childModelPolicySource", "effectiveChildModelKey" }) Assert.True(JsonNode.DeepEquals(presentation[field], dto[field]), field);
        Assert.Equal(presentation["effort"]!["effective"]!.GetValue<string>(), dto["effectiveEffort"]!.GetValue<string>()); Assert.True(JsonNode.DeepEquals(presentation["effort"]!["allowed"], dto["effortAllowed"])); Assert.Equal(presentation["childEffort"]!["effective"]!.GetValue<string>(), dto["effectiveChildEffort"]!.GetValue<string>());
        Assert.Equal(expected["emptyThreshold"]!.GetValue<double>(), dto["effectiveCompactThresholdTokens"]!.GetValue<double>());
        Assert.Throws<InvalidDataException>(() => empty.Resolve(null));
    }
    [Fact]
    public async Task Packaged_templates_seed_only_fresh_or_empty_memory_and_preserve_legacy_and_custom_files()
    {
        foreach (var kind in new[] { "fresh", "empty", "legacy", "custom", "framework" })
        {
            using var temp = new TempDirectory(); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work); var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work); var memory = agents.MemoryDirectory("main");
            if (kind != "fresh") Directory.CreateDirectory(memory);
            if (kind == "legacy") await File.WriteAllTextAsync(agents.MainFallbackSystemPath, "User legacy system.");
            if (kind == "custom") await File.WriteAllTextAsync(Path.Combine(memory, "CUSTOM.md"), "");
            if (kind == "framework") await File.WriteAllTextAsync(agents.FrameworkSystemPath, "Existing framework bytes.");
            await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
            Assert.Equal(work, agents.AgentDirectory("main"));
            if (kind == "legacy") { Assert.False(File.Exists(agents.FrameworkSystemPath)); Assert.Equal("User legacy system.", await File.ReadAllTextAsync(agents.MainFallbackSystemPath)); Assert.Single(Directory.GetFiles(memory)); }
            else
            {
                var expected = kind == "framework" ? "Existing framework bytes." : await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "templates", "agents", "00_SYSTEM.md")); Assert.Equal(expected, await File.ReadAllTextAsync(agents.FrameworkSystemPath));
                if (kind == "custom") { Assert.Single(Directory.GetFiles(memory)); Assert.Equal("", await File.ReadAllTextAsync(Path.Combine(memory, "CUSTOM.md"))); }
                else
                {
                    var source = Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "templates", "main", "memory")); Assert.Equal(source.Length, Directory.GetFiles(memory).Length); Assert.False(File.Exists(Path.Combine(memory, "00_SYSTEM.md")));
                    foreach (var file in source) Assert.Equal(await File.ReadAllBytesAsync(file), await File.ReadAllBytesAsync(Path.Combine(memory, Path.GetFileName(file))));
                }
            }
            var before = Directory.GetFiles(memory).ToDictionary(path => Path.GetFileName(path)!, File.ReadAllText); await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory); Assert.Equal(before, Directory.GetFiles(memory).ToDictionary(path => Path.GetFileName(path)!, File.ReadAllText));
        }
    }
    [Fact]
    public async Task Main_host_does_not_create_main_and_explicit_creation_remains_available()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); catalog.Upsert(Enumerable.Range(0, 1000).Select(index => SessionCatalogTests.Row("cold-" + index, index))); }
        var empty = HostModels.Parse(new JsonObject { ["providers"] = new JsonObject() }, new JsonObject()); await using var manager = new SessionManager(data, work, Options, empty); var reads = new List<string>(); manager.AdmissionReadObserved = reads.Add;
        await manager.LoadMainHostAsync(); Assert.Null(manager.Find("main")); Assert.Empty(manager.Owners()); Assert.Empty(reads); Assert.Null(manager.Catalog.Get("main")); Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json"))); Assert.Equal(1000, manager.Catalog.List().Length);
        var configured = HostModels.ForTest(Options); await using var configuredManager = new SessionManager(Path.Combine(temp.Path, "configured-data"), Path.Combine(temp.Path, "configured-work"), Options, configured); Directory.CreateDirectory(Path.Combine(temp.Path, "configured-work")); await configuredManager.LoadMainHostAsync();
        var main = await configuredManager.CreateNamedAsync("main", "main", null, null); Assert.Equal("main", main.Agent); Assert.Single(configuredManager.Owners()); Assert.NotNull(configuredManager.Catalog.Get("main")); Assert.True(File.Exists(Path.Combine(temp.Path, "configured-data", "state", "sessions", "main.json"))); Assert.False(main.Metadata().Busy);
        Assert.NotNull(main.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]); Assert.Null(main.Entry.Snapshot().AuthorityEnvelope["model"]); Assert.True(Guid.TryParse(main.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.GetValue<string>(), out _));
        var ordinary = await configuredManager.CreateNamedAsync("main", "ordinary-create", null, null); Assert.Equal("ordinary-create", ordinary.Id); Assert.NotNull(configuredManager.Catalog.Get("ordinary-create"));
    }
    [Fact]
    public async Task Existing_main_alias_uses_the_real_lifetime_without_new_main_or_authority_rewrite()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        using (var initial = new SessionCatalog(data)) initial.Initialize();
        await SessionCatalogMigrationTests.Authority(data, "current"); var file = Path.Combine(data, "state", "sessions", "current.json"); var bytes = await File.ReadAllBytesAsync(file);
        using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); catalog.Upsert([SessionCatalogTests.Row("current", 0, aliases: ["main"])]); }
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadMainHostAsync(); var owner = await manager.RequiredAsync("main"); Assert.Equal("current", owner.Id); Assert.Null(manager.Catalog.Get("main")); Assert.Equal(bytes, await File.ReadAllBytesAsync(file)); Assert.Single(manager.Owners());
    }
    [Fact]
    public async Task Archived_or_cold_main_does_not_force_replacement_or_eager_admission()
    {
        foreach (var retained in new[] { true, false })
        {
            using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
            using (var initial = new SessionCatalog(data)) initial.Initialize();
            await SessionCatalogMigrationTests.Authority(data, "queued"); var queuedFile = Path.Combine(data, "state", "sessions", "queued.json"); var raw = JsonNode.Parse(await File.ReadAllTextAsync(queuedFile))!.AsObject(); raw["queue"] = new JsonArray(new JsonObject { ["type"] = "onboot", ["parts"] = new JsonArray(new JsonObject { ["system"] = "Old startup event." }) }); await File.WriteAllTextAsync(queuedFile, raw.ToJsonString());
            using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); var row = SessionCatalogTests.Row("queued", 0); row["queueLength"] = 1; catalog.Upsert(retained ? [row] : [row, SessionCatalogTests.Row("main", 0)]); }
            if (retained) { var archive = new SqliteArchiveMessageStore(Path.Combine(data, "state", "archive-store.sqlite"), "main"); archive.EnsureBranch(); }
            await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options));
            await manager.LoadMainHostAsync(); Assert.Null(manager.Find("main")); Assert.NotNull(manager.Find("queued")); Assert.False(manager.Find("queued")!.Metadata().Busy);
            Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json"))); Assert.Equal(raw.ToJsonString(), await File.ReadAllTextAsync(queuedFile));
        }
    }
}
