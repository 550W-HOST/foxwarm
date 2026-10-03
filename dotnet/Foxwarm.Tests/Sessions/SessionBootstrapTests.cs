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
        var sourceModels = JsonNode.Parse("""[{"default":"","models":{}},{"default":"a","models":{"a":{"providerKey":"a","model":"wire"}}},{"default":"route","models":{"route":{"providerType":"session-hash","virtualRouting":{}}}},{"default":"route","models":{"route":{"providerType":"failover","virtualRouting":{}}}}]""")!;
        var app = new JsonObject { ["llm"] = new JsonObject { ["contextLimit"] = 20000, ["compactThresholdPercent"] = .85 } };
        var session = new JsonObject { ["model"] = "old-model", ["effort"] = "low", ["childModelDefault"] = "old-child", ["childEffortDefault"] = "max" };
        var input = new JsonObject { ["time"] = time, ["content"] = content, ["models"] = sourceModels, ["app"] = app.DeepClone(), ["session"] = session.DeepClone() };
        var repo = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT") ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(new ProcessStartInfo("node") { WorkingDirectory = repo, ArgumentList = { Path.Combine(repo, "dotnet", "onboot-fixture-ts.mjs") }, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
        await process.StandardInput.WriteAsync(input.ToJsonString()); process.StandardInput.Close(); var output = await process.StandardOutput.ReadToEndAsync(); var error = await process.StandardError.ReadToEndAsync(); await process.WaitForExitAsync(); Assert.True(process.ExitCode == 0, error); var expected = JsonNode.Parse(output)!;
        Assert.Equal(expected["wrapper"]!.GetValue<string>(), wrapper);
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        var empty = HostModels.Parse(new JsonObject { ["providers"] = new JsonObject() }, app);
        await using var manager = new SessionManager(data, work, Options, empty); await manager.LoadMainHostAsync();
        var envelope = (JsonObject)manager.Find("main")!.Entry.Snapshot().AuthorityEnvelope.DeepClone(); foreach (var (key, value) in session) envelope[key] = value?.DeepClone();
        var snapshot = manager.Find("main")!.Entry.Snapshot() with { AuthorityEnvelope = envelope };
        var dto = WebUiContract.Session(snapshot, empty, false, false); var presentation = expected["emptyPresentation"]!;
        foreach (var field in new[] { "model", "modelKey", "defaultModelKey", "childModelDefault", "childModelPolicySource", "effectiveChildModelKey" }) Assert.True(JsonNode.DeepEquals(presentation[field], dto[field]), field);
        Assert.Equal(presentation["effort"]!["effective"]!.GetValue<string>(), dto["effectiveEffort"]!.GetValue<string>()); Assert.True(JsonNode.DeepEquals(presentation["effort"]!["allowed"], dto["effortAllowed"])); Assert.Equal(presentation["childEffort"]!["effective"]!.GetValue<string>(), dto["effectiveChildEffort"]!.GetValue<string>());
        Assert.Equal(expected["emptyThreshold"]!.GetValue<double>(), dto["effectiveCompactThresholdTokens"]!.GetValue<double>());
        Assert.Throws<InvalidDataException>(() => empty.Resolve(null));
        var runtimeDto = manager.Find("main")!.BuildDto(); Assert.Equal("", runtimeDto["modelKey"]!.GetValue<string>()); Assert.Equal("high", runtimeDto["effortDefault"]!.GetValue<string>()); Assert.Equal(17000, runtimeDto["effectiveCompactThresholdTokens"]!.GetValue<double>());
        var actual = new JsonArray();
        foreach (var kind in new[] { "empty", "concrete", "session-hash", "failover" })
        {
            var providers = new JsonObject(); var key = "";
            if (kind != "empty") { providers["a"] = new JsonObject { ["providerType"] = "openai-responses", ["baseUrl"] = "http://127.0.0.1:1", ["models"] = new JsonArray("wire") }; key = "a"; }
            if (kind is "session-hash" or "failover") { var targets = new JsonArray("a"); if (kind == "failover") { providers["b"] = providers["a"]!.DeepClone(); targets.Add("b"); } providers["route"] = new JsonObject { ["providerType"] = kind, ["targets"] = targets }; key = "route"; }
            var catalog = HostModels.Parse(new JsonObject { ["default"] = key, ["providers"] = providers }, new JsonObject()); actual.Add(catalog.StartupSnapshotModelKey());
        }
        Assert.True(JsonNode.DeepEquals(expected["snapshots"], actual));
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
    public async Task Main_host_ensures_real_main_with_empty_setup_and_admits_only_main_among_unrelated_cold_members()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); catalog.Upsert(Enumerable.Range(0, 1000).Select(index => SessionCatalogTests.Row("cold-" + index, index))); }
        var empty = HostModels.Parse(new JsonObject { ["providers"] = new JsonObject() }, new JsonObject()); await using var manager = new SessionManager(data, work, Options, empty); var reads = new List<string>(); manager.AdmissionReadObserved = reads.Add;
        await manager.LoadMainHostAsync(); var main = manager.Find("main")!; Assert.NotNull(main); Assert.Equal("main", main.Agent); Assert.Single(manager.Owners()); Assert.Empty(reads); Assert.NotNull(manager.Catalog.Get("main")); Assert.True(File.Exists(Path.Combine(data, "state", "sessions", "main.json"))); Assert.Equal(1001, manager.Catalog.List().Length); Assert.False(main.Metadata().Busy);
        Assert.Equal("", main.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>()); Assert.Null(main.Entry.Snapshot().AuthorityEnvelope["model"]); Assert.Null(main.Entry.Snapshot().AuthorityEnvelope["effort"]); Assert.True(Guid.TryParse(main.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.GetValue<string>(), out _));
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.CreateNamedAsync("main", "ordinary-create", null, null)); Assert.Null(manager.Catalog.Get("ordinary-create"));
    }
    [Fact]
    public async Task Existing_main_alias_uses_the_real_lifetime_without_new_main_or_authority_rewrite()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        using (var initial = new SessionCatalog(data)) initial.Initialize();
        await SessionCatalogMigrationTests.Authority(data, "current"); var file = Path.Combine(data, "state", "sessions", "current.json"); var bytes = await File.ReadAllBytesAsync(file);
        using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); catalog.Upsert([SessionCatalogTests.Row("current", 0, aliases: ["main"])]); }
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadMainHostAsync(); Assert.Equal("current", manager.Find("main")!.Id); Assert.Null(manager.Catalog.Get("main")); Assert.Equal(bytes, await File.ReadAllBytesAsync(file)); Assert.Single(manager.Owners());
    }
    [Fact]
    public async Task Archived_main_or_unavailable_main_fails_before_any_mandatory_sibling_is_started()
    {
        foreach (var retained in new[] { true, false })
        {
            using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
            using (var initial = new SessionCatalog(data)) initial.Initialize();
            await SessionCatalogMigrationTests.Authority(data, "queued"); var queuedFile = Path.Combine(data, "state", "sessions", "queued.json"); var raw = JsonNode.Parse(await File.ReadAllTextAsync(queuedFile))!.AsObject(); raw["queue"] = new JsonArray(new JsonObject { ["type"] = "onboot", ["parts"] = new JsonArray(new JsonObject { ["system"] = "Old startup event." }) }); await File.WriteAllTextAsync(queuedFile, raw.ToJsonString());
            using (var catalog = new SessionCatalog(data)) { catalog.Initialize(); var row = SessionCatalogTests.Row("queued", 0); row["queueLength"] = 1; catalog.Upsert(retained ? [row] : [row, SessionCatalogTests.Row("main", 0)]); }
            if (retained) { var archive = new SqliteArchiveMessageStore(Path.Combine(data, "state", "archive-store.sqlite"), "main"); archive.EnsureBranch(); }
            await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await Assert.ThrowsAnyAsync<Exception>(manager.LoadMainHostAsync); Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json"))); Assert.False(manager.Find("queued")?.Metadata().Busy ?? false); Assert.Equal(raw.ToJsonString(), await File.ReadAllTextAsync(queuedFile));
        }
    }
    [Fact]
    public async Task Onboot_reads_once_waits_real_three_seconds_and_close_drains_without_repeating_or_late_enqueue()
    {
        using var temp = new TempDirectory(); var file = Path.Combine(temp.Path, "ONBOOT.md"); const string original = "  Original ONBOOT body.\n"; await File.WriteAllTextAsync(file, original);
        var queued = new List<string>(); var errors = new List<string>(); var clock = Stopwatch.StartNew();
        await using (var producer = new SessionOnbootProducer(file, (message, token) => { queued.Add(message); return Task.CompletedTask; }, (stage, error) => errors.Add(stage)))
        {
            producer.Start(); producer.Start(); await Task.Delay(300); await File.WriteAllTextAsync(file, "Changed after the startup read."); await producer.DrainAsync(); Assert.True(clock.Elapsed.TotalMilliseconds >= 2990); Assert.Equal("ONBOOT: " + original, Assert.Single(queued)); Assert.Empty(errors);
        }
        queued.Clear(); await using (var stopped = new SessionOnbootProducer(file, (message, token) => { queued.Add(message); return Task.CompletedTask; }, (stage, error) => errors.Add(stage))) { stopped.Start(); await Task.Delay(100); stopped.Close(); await stopped.DrainAsync(); Assert.Empty(queued); }
        foreach (var content in new string?[] { null, " \n\ufeff" })
        {
            if (content is null) File.Delete(file); else await File.WriteAllTextAsync(file, content);
            await using var producer = new SessionOnbootProducer(file, (message, token) => { queued.Add(message); return Task.CompletedTask; }, (stage, error) => errors.Add(stage)); producer.Start(); await producer.DrainAsync(); Assert.Empty(queued); Assert.Empty(errors);
        }
        File.Delete(file); Directory.CreateDirectory(file);
        await using (var failing = new SessionOnbootProducer(file, (message, token) => Task.CompletedTask, (stage, error) => errors.Add(stage))) { failing.Start(); await failing.DrainAsync(); Assert.Equal("Error processing ONBOOT.md", Assert.Single(errors)); }
    }
}
