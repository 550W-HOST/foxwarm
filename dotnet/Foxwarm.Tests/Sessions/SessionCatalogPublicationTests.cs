using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class SessionCatalogPublicationTests
{
    [Fact]
    public async Task Idle_committed_settings_failure_keeps_hot_projection_and_cold_newer_JSON_without_catalog_reconstruction()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        var models = HostModels.Parse(JsonNode.Parse("""{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]},"b":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire-b"]}}}""")!.AsObject(), new JsonObject());
        await using var manager = new SessionManager(data, work, options, models); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "one", null, null); var runtime = new SessionRuntime(manager);
        manager.Catalog.BeforeAuthorityProjection = _ => throw new IOException("Owned projection fault.");
        await Assert.ThrowsAsync<AuthorityCommittedException>(() => runtime.UpdateSettingsAsync(owner.Id, new JsonObject { ["model"] = "b" }));
        Assert.Equal("b", owner.Entry.Snapshot().AuthorityEnvelope["model"]!.GetValue<string>()); Assert.Null(manager.Catalog.Get(owner.Id)!["model"]);
        Assert.False(owner.Entry.Snapshot().Busy); Assert.Equal("b", new SessionListQueries(runtime).Projection(owner.Id)!["model"]!.GetValue<string>());
        Assert.Single(manager.LocalProjections());
        var root = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", owner.Id + ".json")))!; Assert.Equal("b", root["model"]!.GetValue<string>());
        // A separately instantiated real cold owner reads catalog membership + newer JSON.
        // The source Manager is deliberately kept unchanged: no copy or projection retry is used.
        await using var cold = new SessionManager(data, work, options, models); await cold.LoadAsync(); Assert.Empty(cold.Owners()); await cold.RequiredAsync(owner.Id);
        Assert.Equal("b", new SessionListQueries(new SessionRuntime(cold)).Projection(owner.Id)!["model"]!.GetValue<string>());
        Assert.Null(cold.Catalog.Get(owner.Id)!["model"]); Assert.Single(cold.LocalProjections());
        manager.Catalog.BeforeAuthorityProjection = null; await owner.Entry.SaveLane.SaveStrictAsync(); owner.PublishStateChanged();
        Assert.Equal("b", manager.Catalog.Get(owner.Id)!["model"]!.GetValue<string>()); Assert.Empty(manager.LocalProjections());
    }

    [Fact]
    public async Task Idle_threshold_only_catalog_failure_keeps_the_current_visible_setting()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713); var models = HostModels.ForTest(options);
        await using var manager = new SessionManager(data, work, options, models); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "one", null, null); var runtime = new SessionRuntime(manager);
        manager.Catalog.BeforeAuthorityProjection = _ => throw new IOException("Owned threshold projection fault.");
        await Assert.ThrowsAsync<AuthorityCommittedException>(() => owner.Entry.SaveLane.CommitSettingsAsync(new JsonObject { ["compactThresholdTokens"] = 3000 }, models));
        Assert.Null(manager.Catalog.Get(owner.Id)!["compactThresholdTokens"]); Assert.False(owner.Entry.Snapshot().Busy);
        Assert.Equal(3000, new SessionListQueries(runtime).Projection(owner.Id)!["compactThresholdTokens"]!.GetValue<double>()); Assert.Single(manager.LocalProjections());
        manager.Catalog.BeforeAuthorityProjection = null; await owner.Entry.SaveLane.SaveStrictAsync(); owner.PublishStateChanged(); Assert.Empty(manager.LocalProjections());
    }

    [Fact]
    public async Task Catalog_lastChannel_hydrates_as_Main_only_without_entering_the_semantic_validator_or_new_JSON()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        await SessionCatalogMigrationTests.Authority(data, "one");
        var record = SessionCatalogTests.Row("one", 0); record["meta"]!["lastChannel"] = new JsonObject { ["channelId"] = "webui", ["channelUserId"] = "room" };
        var source = Path.Combine(data, "state", "sessions.json"); await File.WriteAllTextAsync(source, new JsonObject { ["sessions"] = new JsonObject { ["one"] = record } }.ToJsonString());
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713); await using var manager = new SessionManager(data, work, options, HostModels.ForTest(options));
        await manager.LoadAsync(); var owner = await manager.RequiredAsync("one"); Assert.Null(owner.Entry.Snapshot().Meta["lastChannel"]);
        Assert.Equal("webui", manager.Catalog.Get("one")!["meta"]!["lastChannel"]!["channelId"]!.GetValue<string>());
        await owner.Entry.SaveLane.SaveStrictAsync(); Assert.Null(JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", "one.json")))!["meta"]!["lastChannel"]);
        Assert.Equal("room", manager.Catalog.Get("one")!["meta"]!["lastChannel"]!["channelUserId"]!.GetValue<string>());
    }

    [Fact]
    public async Task Main_name_wins_a_real_overlapping_staged_semantic_save()
    {
        using var temp = new TempDirectory(); using var catalog = new SessionCatalog(temp.Path); catalog.Initialize(); var row = SessionCatalogTests.Row("one", 0); row["displayName"] = "Old"; catalog.Upsert([row]);
        using var reached = new ManualResetEventSlim(); using var release = new ManualResetEventSlim(); var armed = false;
        var store = new PersistentSessionAuthorityStore(temp.Path, "one", authorityStageHook: stage =>
        {
            if (!armed || stage != AtomicJsonWriteStage.BeforeRename) return; reached.Set(); if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Owned save barrier timed out.");
        }, publishProjection: snapshot =>
        {
            var source = (JsonObject)snapshot.AuthorityEnvelope.DeepClone(); source["id"] = "one"; source["queueLength"] = 0; source["meta"] = snapshot.Meta.DeepClone(); catalog.PublishAuthority(source);
        }, mainFields: () => catalog.Get("one"));
        var registry = new SessionRegistry(store, new ControlledChat()); var entry = registry.Add("one"); await entry.SaveLane.SaveStrictAsync(); armed = true;
        var save = Task.Run(() => entry.SaveLane.SaveStrictAsync()); Assert.True(reached.Wait(TimeSpan.FromSeconds(5))); catalog.Rename("one", "New"); release.Set(); await save;
        Assert.Equal("New", catalog.Get("one")!["displayName"]!.GetValue<string>());
        armed = false; await entry.SaveLane.SaveStrictAsync(); Assert.Equal("New", JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(temp.Path, "state", "sessions", "one.json")))!["displayName"]!.GetValue<string>());
    }

    [Fact]
    public async Task Declared_predecessor_import_rechecks_the_frozen_file_set_before_publication()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work); await SessionCatalogMigrationTests.Authority(data, "one");
        using var catalog = new SessionCatalog(data); catalog.BeforeImportFreezeCheck = () => File.WriteAllText(Path.Combine(data, "state", "sessions", "one.json"), "changed");
        Assert.Throws<IOException>(() => catalog.ImportDotNetV1(new AgentCatalog(data, work))); Assert.False(File.Exists(catalog.FilePath));
        Assert.Empty(Directory.GetFiles(Path.Combine(data, "state"), "catalog.sqlite.migrating-*"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Declared_import_rejects_a_new_Archive_input_or_nonempty_WAL_before_catalog_publication(bool wal)
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work); await SessionCatalogMigrationTests.Authority(data, "one");
        var archive = Path.Combine(data, "state", "archive-store.sqlite"); if (!wal) File.Delete(archive);
        using var catalog = new SessionCatalog(data); catalog.BeforeImportFreezeCheck = () => File.WriteAllText(archive + (wal ? "-wal" : ""), "New input after validation.");
        Assert.Throws<IOException>(() => catalog.ImportDotNetV1(new AgentCatalog(data, work))); Assert.False(File.Exists(catalog.FilePath));
        Assert.Empty(Directory.GetFiles(Path.Combine(data, "state"), "catalog.sqlite.migrating-*"));
    }

    [Fact]
    public async Task Self_and_committed_redirect_reservations_stay_nonlive_and_read_without_changing_ownership()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        await SessionCatalogMigrationTests.Authority(data, "one"); var database = Path.Combine(data, "state", "archive-store.sqlite");
        using (var connection = new SqliteConnection($"Data Source={database}"))
        {
            connection.Open(); using var command = connection.CreateCommand(); command.CommandText = """
CREATE TABLE IF NOT EXISTS archive_session_id_reservations(session_id TEXT PRIMARY KEY,canonical_session_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_archive_session_id_reservations_canonical ON archive_session_id_reservations(canonical_session_id);
INSERT INTO archive_session_id_reservations VALUES('one','one',1,1),('gone','gone',2,2),('old','new',3,3);
"""; command.ExecuteNonQuery();
        }
        var record = SessionCatalogTests.Row("one", 0); await File.WriteAllTextAsync(Path.Combine(data, "state", "sessions.json"), new JsonObject { ["sessions"] = new JsonObject { ["one"] = record } }.ToJsonString());
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713); await using var manager = new SessionManager(data, work, options, HostModels.ForTest(options)); await manager.LoadAsync();
        Assert.NotNull(await manager.GetExistingAsync("one")); Assert.Null(manager.Find("gone"));
        foreach (var id in new[] { "gone", "old", "new" }) await Assert.ThrowsAsync<InvalidDataException>(() => manager.CreateNamedAsync("main", id, null, null));
        var redirected = new SqliteArchiveMessageStore(database, "old"); Assert.Empty(redirected.ReadMessages());
        var child = new SqliteArchiveMessageStore(database, "branch-child"); child.Initialize(); child.EnsureBranch("old", 100, 100); Assert.Empty(child.ReadEffectiveMessagesRange(1, 100));
        using var verify = new SqliteConnection($"Data Source={database};Mode=ReadOnly"); verify.Open(); using var select = verify.CreateCommand(); select.CommandText = "SELECT COUNT(*) FROM archive_session_id_reservations"; Assert.Equal(3L, select.ExecuteScalar());
    }
}
