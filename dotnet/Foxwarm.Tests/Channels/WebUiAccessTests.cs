using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WebUiAccessTests
{
    private static JsonObject App(string identities) =>
        ConfigurationYaml.Parse("access:\n  identities: " + identities + "\n", "app config");

    private const string Alice =
        "{alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}, mcp: {}}}}";

    [Fact]
    public void Whole_map_validation_is_bounded_and_secret_safe()
    {
        var invalid = new[]
        {
            "null",
            "[]",
            "{identities: []}",
            "{identities: {alice: {token: secret-value, surfaces: {}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {mcp: {enabled: true}}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {webui: {sessions: ['*']}}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {webui: {sessions: ['agent/*/x']}}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {webui: {sessions: [chat, chat]}}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {webui: {sessions: [chat], extra: secret-value}}}}}",
            "{identities: {alice: {token: secret-value, surfaces: {mcp: {}}}, bob: {token: secret-value, surfaces: {mcp: {}}}}}",
            "{identities: {alice: {token: 'secret-value bad', surfaces: {mcp: {}}}}}",
            "{identities: {alice: {token: '" + new string('x', 4097) + "', surfaces: {mcp: {}}}}}",
        };
        foreach (var access in invalid)
        {
            var parsed = ConfigurationYaml.Parse("access: " + access, "app config");
            var error = Assert.Throws<InvalidDataException>(() =>
                AppConfigurationRules.Validate(parsed)
            );
            Assert.DoesNotContain("secret-value", error.Message);
        }
        var normalized = AccessConfiguration.Normalize(App(Alice)["access"]);
        Assert.True(normalized["alice"].Mcp);
        Assert.Equal("chat", Assert.Single(normalized["alice"].Sessions));
    }

    [Fact]
    public async Task Raw_install_publishes_only_after_persistence_and_reports_staged_Mcp_and_cleanup_truthfully()
    {
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(temp.Path);
        config.Access.ReserveInstanceToken("synthetic-admin");
        var calls = 0;
        config.Access.Changed += async change =>
        {
            calls++;
            Assert.Equal(change.Current, config.Access.Snapshot);
            Assert.Contains("synthetic-alice", await File.ReadAllTextAsync(config.AppPath));
            throw new IOException("synthetic cleanup failure");
        };
        var raw = "# raw comment\r\naccess:\r\n  identities: " + Alice + "\r\n";
        var result = await config.SaveAppAsync(raw);
        Assert.Equal(raw, await File.ReadAllTextAsync(config.AppPath));
        Assert.Contains("access.identities", result["applied"]!.ToString());
        Assert.Contains("access.surfaces.mcp", result["notApplied"]!.ToString());
        Assert.Contains("access.connections", result["notApplied"]!.ToString());
        Assert.Contains("access.surfaces.mcp", result["restartRequired"]!.ToString());
        Assert.NotNull(config.Access.Authenticate("synthetic-alice"));
        Assert.Equal(1, calls);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            config.SaveAppAsync(raw.Replace("synthetic-alice", "synthetic-admin"))
        );
        Assert.Equal(raw, await File.ReadAllTextAsync(config.AppPath));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task Failed_save_never_publishes_and_listener_fences_are_all_invoked_before_awaiting_cleanup()
    {
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(temp.Path);
        Directory.CreateDirectory(config.AppPath);
        await Assert.ThrowsAnyAsync<IOException>(() =>
            config.SaveAppAsync(App(Alice).ToJsonString())
        );
        Assert.Empty(config.Access.Snapshot);
        var access = new AccessConfiguration(App(Alice));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fenced = false;
        access.Changed += _ => release.Task;
        access.Changed += _ =>
        {
            fenced = true;
            return Task.CompletedTask;
        };
        var applying = access.ApplyAsync(AccessConfiguration.Normalize(null, false));
        Assert.True(fenced);
        Assert.False(applying.IsCompleted);
        Assert.Null(access.Authenticate("synthetic-alice"));
        release.SetResult();
        await applying;
    }

    [Fact]
    public async Task Other_surface_and_identity_edits_preserve_browser_authority_but_scope_or_token_edits_revoke_it()
    {
        var access = new AccessConfiguration(App(Alice));
        var verified = access.Authenticate("synthetic-alice")!.Value;
        var affected = new List<string>();
        access.Changed += change =>
        {
            affected.AddRange(change.WebUi);
            return Task.CompletedTask;
        };
        await access.ApplyAsync(
            AccessConfiguration.Normalize(App(Alice.Replace(", mcp: {}", ""))["access"])
        );
        Assert.True(access.Current(verified.Id, verified.Identity));
        Assert.Empty(affected);
        await access.ApplyAsync(
            AccessConfiguration.Normalize(App(Alice.Replace("[chat]", "[chat, second]"))["access"])
        );
        Assert.False(access.Current(verified.Id, verified.Identity));
        Assert.Equal("alice", Assert.Single(affected));
    }

    [Fact]
    public async Task Scoped_upload_authority_is_identity_and_session_owned_and_revocation_removes_only_affected_staging()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "chat", null, null);
        var other = await manager.CreateNamedAsync("main", "other", null, null);
        var app = App(
            "{alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat, other]}}}, bob: {token: synthetic-bob, surfaces: {webui: {sessions: [chat]}}}}"
        );
        var config = new AccessConfiguration(app);
        using var access = new WebUiAccess(new SessionRuntime(manager), config);
        access.Start();
        WebUiRequest Login(string token)
        {
            var context = new DefaultHttpContext();
            context.Request.Headers.Authorization = "Bearer " + token;
            return access.Authenticate(context)!;
        }
        var alice = Login("synthetic-alice");
        var bob = Login("synthetic-bob");
        var a = Path.Combine(temp.Path, "alice");
        var b = Path.Combine(temp.Path, "bob");
        await File.WriteAllTextAsync(a, "owned a");
        await File.WriteAllTextAsync(b, "owned b");
        alice.RegisterUpload(owner.Id, a);
        bob.RegisterUpload(owner.Id, b);
        alice.RequireUpload(owner.Id, a);
        Assert.Throws<WebUiAccessException>(() => bob.RequireUpload(owner.Id, a));
        Assert.Throws<WebUiAccessException>(() => alice.RequireUpload(other.Id, a));
        await config.ApplyAsync(
            AccessConfiguration.Normalize(
                App("{bob: {token: synthetic-bob, surfaces: {webui: {sessions: [chat]}}}}")[
                    "access"
                ]
            )
        );
        Assert.False(File.Exists(a));
        Assert.True(File.Exists(b));
        bob.RequireUpload(owner.Id, b);
        await manager.ShutdownAsync();
    }

    [Fact]
    public async Task Final_live_check_rejects_a_queued_input_before_hot_admission_but_does_not_roll_back_an_admitted_input()
    {
        var config = new AccessConfiguration(App(Alice));
        var verified = config.Authenticate("synthetic-alice")!.Value;
        void Require()
        {
            if (!config.Current(verified.Id, verified.Identity))
                throw new WebUiAccessException();
        }
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, new FakeChatService())
        {
            TriggerOverride = _ => Task.CompletedTask,
        };
        var entry = registry.Add("chat");
        store.Hold("chat");
        var earlierWriter = entry.SaveLane.SaveStrictAsync();
        await store.WaitForCommitAsync("chat").WaitAsync(TimeSpan.FromSeconds(5));
        var rejected = registry.Ingress.EnqueueCheckedAsync(
            "chat",
            QueueItem.UserText("must not enter"),
            Require
        );
        Assert.False(rejected.IsCompleted);
        await config.ApplyAsync(AccessConfiguration.Normalize(null, false));
        store.Release("chat");
        await earlierWriter;
        await Assert.ThrowsAsync<WebUiAccessException>(() => rejected);
        Assert.Empty(entry.Snapshot().Queue);
        Assert.Empty((await store.LoadAsync("chat"))!.Queue);

        await config.ApplyAsync(AccessConfiguration.Normalize(App(Alice)["access"]));
        store.ResetCommitSignal("chat");
        store.Hold("chat");
        var accepted = registry.Ingress.EnqueueCheckedAsync(
            "chat",
            QueueItem.UserText("already admitted"),
            Require
        );
        await store.WaitForCommitAsync("chat").WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(entry.Snapshot().Queue);
        await config.ApplyAsync(AccessConfiguration.Normalize(null, false));
        store.Release("chat");
        await accepted;
        Assert.Single(entry.Snapshot().Queue);
        Assert.Single((await store.LoadAsync("chat"))!.Queue);
    }

    [Fact]
    public void Session_download_mac_keeps_independent_resource_lifetime_and_namespaces()
    {
        var signer = new WebUiDownloadSignatures("synthetic-admin", () => 100);
        var grant = signer.Issue("blob", "blob", new JsonObject(), "chat");
        var query = new QueryCollection(
            Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(grant.Query)
        );
        Assert.True(signer.Verify("blob", "blob", query, "chat"));
        Assert.False(signer.Verify("blob", "blob", query));
        Assert.False(signer.Verify("blob", "blob", query, "other"));
        Assert.False(
            new WebUiDownloadSignatures("rotated-admin", () => 100).Verify(
                "blob",
                "blob",
                query,
                "chat"
            )
        );
        Assert.False(
            new WebUiDownloadSignatures("synthetic-admin", () => 1000).Verify(
                "blob",
                "blob",
                query,
                "chat"
            )
        );
    }
}
