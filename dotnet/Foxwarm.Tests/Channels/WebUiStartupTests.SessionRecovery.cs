using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Local_authority_failure_is_logged_safely_and_access_reports_it_while_HTTP_and_healthy_sessions_start()
    {
        await using var host = new Host();
        await File.AppendAllTextAsync(host.ConfigPath, "vector: false\nchannels: {}\n");
        await File.WriteAllTextAsync(host.TokenPath, host.Token);
        await SessionUpgradeCompatibilityTests.Seed(host.Data, "healthy", required: true);
        await SessionUpgradeCompatibilityTests.Seed(host.Data, "broken", required: true);
        await SessionUpgradeCompatibilityTests.Seed(host.Data, "cold");
        var original = new Dictionary<string, string>();
        foreach (var id in new[] { "broken", "cold" })
        {
            var path = Path.Combine(host.Data, "state", "sessions", id + ".json");
            var raw = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            raw["queue"] = new JsonArray(new JsonObject { ["type"] = "credential-and-vendor-body-must-not-leak", ["parts"] = new JsonArray(new JsonObject { ["text"] = "keep-this-input" }) });
            original[id] = raw.ToJsonString();
            await File.WriteAllTextAsync(path, original[id]);
        }
        host.Start();
        await host.Ready();
        Assert.Equal(HttpStatusCode.OK, (await host.Client.GetAsync("/api/sessions/healthy/state")).StatusCode);
        foreach (var id in new[] { "broken", "cold" })
        {
            var response = await host.Client.GetAsync("/api/sessions/" + id + "/state");
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.Equal("SESSION_STATE_UNAVAILABLE", body!["code"]!.GetValue<string>());
            var diagnostic = body["error"]!.GetValue<string>();
            Assert.Contains("state/sessions/" + id + ".json", diagnostic);
            Assert.Contains("queue[0].type", diagnostic);
            Assert.DoesNotContain("credential-and-vendor-body", diagnostic);
            Assert.DoesNotContain(host.Data, diagnostic);
        }
        await host.Stop();
        var output = await host.Output();
        Assert.Contains("Session recovery failed:", output);
        Assert.Contains("state/sessions/broken.json", output);
        Assert.DoesNotContain("credential-and-vendor-body", output);
        var log = await File.ReadAllTextAsync(Path.Combine(host.Data, "state", "logs", "foxwarm.log"));
        Assert.Contains("state/sessions/broken.json", log);
        Assert.DoesNotContain("credential-and-vendor-body", log);
        foreach (var (id, before) in original)
            Assert.Equal(before, await File.ReadAllTextAsync(Path.Combine(host.Data, "state", "sessions", id + ".json")));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task First_catalog_migration_isolates_local_files_but_identity_conflicts_remain_fatal(bool identityConflict)
    {
        await using var host = new Host();
        await File.AppendAllTextAsync(host.ConfigPath, "vector: false\nchannels: {}\n");
        await File.WriteAllTextAsync(host.TokenPath, host.Token);
        foreach (var id in new[] { "healthy", "broken" })
            await SessionCatalogMigrationTests.Authority(host.Data, id);
        var path = Path.Combine(host.Data, "state", "sessions", "broken.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        if (identityConflict)
            raw["id"] = "credential-shaped-foreign-identity";
        else
            raw["lastAppliedMailboxId"] = -1;
        var original = raw.ToJsonString();
        await File.WriteAllTextAsync(path, original);
        var members = new JsonObject();
        foreach (var id in new[] { "healthy", "broken" })
        {
            var row = SessionCatalogTests.Row(id, 0);
            row["queueLength"] = 1;
            members[id] = row;
        }
        var candidate = Path.Combine(host.Data, "state", "sessions.json");
        await File.WriteAllTextAsync(candidate, new JsonObject { ["sessions"] = members }.ToJsonString());
        host.Start();
        if (identityConflict)
        {
            await host.Failed();
            var output = await host.Output();
            Assert.Contains("Main fatal startup failure", output);
            Assert.Contains("state/sessions/broken.json", output);
            Assert.Contains("catalog ID", output);
            Assert.DoesNotContain("credential-shaped-foreign-identity", output);
            Assert.True(File.Exists(candidate));
            Assert.False(File.Exists(Path.Combine(host.Data, "state", "catalog.sqlite")));
        }
        else
        {
            await host.Ready();
            Assert.Equal(HttpStatusCode.OK, (await host.Client.GetAsync("/api/sessions/healthy/state")).StatusCode);
            Assert.Equal(HttpStatusCode.InternalServerError, (await host.Client.GetAsync("/api/sessions/broken/state")).StatusCode);
            await host.Stop();
            Assert.False(File.Exists(candidate));
            using var catalog = new SessionCatalog(host.Data);
            Assert.Equal(2, catalog.List().Length);
        }
        Assert.Equal(original, await File.ReadAllTextAsync(path));
    }

}
