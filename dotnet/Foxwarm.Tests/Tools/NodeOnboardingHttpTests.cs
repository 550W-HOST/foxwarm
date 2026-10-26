using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class NodeOnboardingHttpTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal MainHost Host = null!;
        internal HttpClient Admin = null!;
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string RegistryPath => Path.Combine(Data, "state", "nodes.json");
        internal SessionManager Sessions =>
            (SessionManager)
                typeof(MainHost)
                    .GetField("sessions", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .GetValue(Host)!;
        internal NodeConnectionHub Hub => Sessions.Nodes;

        internal static async Task<Fixture> Start()
        {
            var fixture = new Fixture();
            Directory.CreateDirectory(Path.Combine(fixture.Data, "state"));
            await File.WriteAllTextAsync(
                Path.Combine(fixture.Data, "state", "config.yaml"),
                """
                vector: {enabled: false}
                bot: {enableWebUI: true, enableTrigger: false}
                access:
                  identities:
                    reader:
                      token: synthetic-onboarding-reader
                      surfaces: {webui: {sessions: [main]}}
                """
            );
            var configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(fixture.Data, fixture.Temp.Path, environment: _ => null)
            );
            var settings = await HttpServerSettings.CaptureDesktopAsync(fixture.Data);
            fixture.Host = await MainHost.CreateAsync([], configuration, settings);
            await fixture.Host.StartAsync();
            fixture.Admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
            fixture.Admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
            return fixture;
        }

        internal async Task<JsonObject> Post(
            string action,
            object body,
            HttpStatusCode expected = HttpStatusCode.OK
        )
        {
            using var response = await Admin.PostAsJsonAsync(
                "api/nodes/onboarding/" + action,
                body
            );
            Assert.Equal(expected, response.StatusCode);
            Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }

        internal void ObserveWrite(Action<AtomicJsonWriteStage>? hook)
        {
            var file = typeof(ApprovedNodeRegistry)
                .GetField("file", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(Hub.Registry)!;
            typeof(LinuxAtomicJsonFile)
                .GetField("stageHook", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(file, hook);
        }

        public async ValueTask DisposeAsync()
        {
            Admin.Dispose();
            await Host.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Unconfigured_help_uses_the_assigned_listener_port_without_advertising_loopback()
    {
        await using var fixture = await Fixture.Start();
        var info = fixture.Sessions.Bootstrap!.Info();
        var expected = $"http://YOUR_MASTER:{fixture.Admin.BaseAddress!.Port}";
        Assert.NotEqual(0, fixture.Admin.BaseAddress.Port);
        Assert.Equal(expected, SessionWait.Text(info["baseUrl"]));
        Assert.Contains(
            expected + "/node/run.sh",
            SessionWait.Text(info["commands"]?["bareMetal"])
        );
        Assert.All(
            info["endpoints"]!.AsArray(),
            endpoint => Assert.StartsWith(expected + "/node/", endpoint!.GetValue<string>())
        );
    }

    [Fact]
    public async Task Explicit_creation_and_regeneration_share_persisted_credentials_for_every_original_launcher()
    {
        await using var fixture = await Fixture.Start();
        const string url = "https://example.invalid/mount'path/$literal";
        var pairing = await fixture.Post("commands", new { baseUrl = url });
        Assert.Contains("--pairing=", pairing["commands"]!["bareMetal"]!.GetValue<string>());
        Assert.Empty(fixture.Hub.Registry.ListApproved());
        var directOnly = await fixture.Post(
            "commands",
            new { baseUrl = url, authToken = "literal'$credential" }
        );
        Assert.Contains(
            "--auth-token='literal'\"'\"'$credential'",
            directOnly["commands"]!["interactive"]!.GetValue<string>()
        );
        Assert.Contains(
            "-AuthToken 'literal''$credential'",
            directOnly["commands"]!["windows"]!.GetValue<string>()
        );
        Assert.Contains(
            "NODE_AUTH_TOKEN='literal\\'$credential'",
            directOnly["commands"]!["manualCompose"]!.GetValue<string>()
        );
        Assert.Empty(fixture.Hub.Registry.ListApproved());

        var created = await fixture.Post(
            "create",
            new
            {
                baseUrl = url,
                nodeId = "owned-node",
                installDir = "/opt/node's directory",
            }
        );
        var token = created["authToken"]!.GetValue<string>();
        Assert.Equal(url, created["baseUrl"]!.GetValue<string>());
        var commands = created["commands"]!.AsObject();
        Assert.Equal(9, commands.Count);
        foreach (var command in commands)
        {
            var text = command.Value!.GetValue<string>();
            Assert.Contains(token, text);
            Assert.DoesNotContain(fixture.Hub.Registry.PairingToken, text);
            Assert.DoesNotContain("--pairing=", text);
            Assert.DoesNotContain("-Pairing ", text);
        }
        foreach (
            var method in new[]
            {
                "bareMetal",
                "bareMetalBackground",
                "bareMetalInstall",
                "docker",
                "interactive",
            }
        )
            Assert.Contains("--auth-token='" + token + "'", commands[method]!.GetValue<string>());
        Assert.Contains("-AuthToken '" + token + "'", commands["windows"]!.GetValue<string>());
        Assert.Contains("NODE_AUTH_TOKEN='" + token + "'", commands["shell"]!.GetValue<string>());
        Assert.Contains(
            "NODE_AUTH_TOKEN='" + token + "'",
            commands["manualCompose"]!.GetValue<string>()
        );
        Assert.Contains("NODE_PAIRING_TOKEN=''", commands["manualCompose"]!.GetValue<string>());
        var regenerated = await fixture.Post(
            "commands",
            new
            {
                baseUrl = url,
                nodeId = "owned-node",
                authToken = token,
                installDir = "/opt/changed directory",
            }
        );
        Assert.Contains(
            "--dir='/opt/changed directory'",
            regenerated["commands"]!["bareMetal"]!.GetValue<string>()
        );
        Assert.True(fixture.Hub.Registry.Authenticate("owned-node", token));
        Assert.Single(fixture.Hub.Registry.ListApproved());
        Assert.Empty(fixture.Hub.Registry.ListPending());
        var persisted = await File.ReadAllTextAsync(fixture.RegistryPath);
        Assert.DoesNotContain(token, persisted);
        Assert.Contains("tokenHash", persisted);
        Assert.True(new ApprovedNodeRegistry(fixture.Data).Authenticate("owned-node", token));
        Assert.False(new ApprovedNodeRegistry(fixture.Data).Authenticate("owned-node", "wrong"));
        var summaries = await fixture.Admin.GetStringAsync("api/nodes");
        var pending = await fixture.Admin.GetStringAsync("api/nodes/onboarding/pending");
        foreach (var text in new[] { summaries, pending })
        {
            Assert.DoesNotContain(token, text);
            Assert.DoesNotContain("tokenHash", text);
            Assert.DoesNotContain("authToken", text);
        }
        var shell = await fixture.Post(
            "create-shell",
            new { baseUrl = url, nodeId = "owned-shell" }
        );
        Assert.Equal(
            new[] { "command", "nodeId" },
            shell.Select(pair => pair.Key).Order().ToArray()
        );
        Assert.Contains("NODE_AUTH_TOKEN=", shell["command"]!.GetValue<string>());
    }

    [Fact]
    public async Task Invalid_inputs_denied_callers_and_competing_creations_do_not_silently_reserve_or_retry()
    {
        await using var fixture = await Fixture.Start();
        const string url = "https://example.invalid/mount";
        foreach (var token in new object?[] { null, "", "\nsecret", 42, new { value = "secret" } })
            await fixture.Post(
                "commands",
                new { baseUrl = url, authToken = token },
                HttpStatusCode.BadRequest
            );
        await fixture.Post("create", new { nodeId = "missing-address" }, HttpStatusCode.BadRequest);
        foreach (
            var bad in new[]
            {
                "",
                "https://user:pass@example.invalid",
                "https://example.invalid/?secret",
                "https://example.invalid/\nbad",
            }
        )
            await fixture.Post(
                "create",
                new { baseUrl = bad, nodeId = "invalid-url" },
                HttpStatusCode.BadRequest
            );
        await fixture.Post(
            "create",
            new { baseUrl = url, nodeId = "master" },
            HttpStatusCode.BadRequest
        );
        await fixture.Post(
            "create",
            new
            {
                baseUrl = url,
                nodeId = "invalid-dir",
                installDir = "\nbad",
            },
            HttpStatusCode.BadRequest
        );
        using var anonymous = new HttpClient { BaseAddress = fixture.Admin.BaseAddress };
        using var scoped = new HttpClient { BaseAddress = fixture.Admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-onboarding-reader");
        foreach (var action in new[] { "commands", "create", "create-shell" })
        {
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (
                    await anonymous.PostAsJsonAsync(
                        "api/nodes/onboarding/" + action,
                        new { baseUrl = url, nodeId = "denied" }
                    )
                ).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (
                    await scoped.PostAsJsonAsync(
                        "api/nodes/onboarding/" + action,
                        new { baseUrl = url, nodeId = "denied" }
                    )
                ).StatusCode
            );
        }
        Assert.Empty(fixture.Hub.Registry.ListApproved());
        var responses = await Task.WhenAll(
            Enumerable
                .Range(0, 2)
                .Select(_ =>
                    fixture.Admin.PostAsJsonAsync(
                        "api/nodes/onboarding/create",
                        new { baseUrl = url, nodeId = "competing" }
                    )
                )
        );
        Assert.Equal(
            new[] { HttpStatusCode.OK, HttpStatusCode.Conflict },
            responses.Select(response => response.StatusCode).Order().ToArray()
        );
        foreach (var response in responses)
            response.Dispose();
        await fixture.Post(
            "create-shell",
            new { baseUrl = url, nodeId = "competing" },
            HttpStatusCode.Conflict
        );
        Assert.Single(fixture.Hub.Registry.ListApproved());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Persistence_failure_returns_no_credential_and_preserves_existing_registry_failure_semantics(
        bool committed
    )
    {
        await using var fixture = await Fixture.Start();
        fixture.ObserveWrite(stage =>
        {
            if (
                stage
                == (
                    committed
                        ? AtomicJsonWriteStage.AfterDirectorySync
                        : AtomicJsonWriteStage.BeforeRename
                )
            )
                throw new IOException("private persistence detail");
        });
        var failure = await fixture.Post(
            "create",
            new { baseUrl = "https://example.invalid", nodeId = "failed-create" },
            HttpStatusCode.InternalServerError
        );
        fixture.ObserveWrite(null);
        Assert.DoesNotContain("private persistence detail", failure.ToJsonString());
        Assert.DoesNotContain("authToken", failure.ToJsonString());
        Assert.Equal(committed ? 1 : 0, fixture.Hub.Registry.ListApproved().Count);
        Assert.Equal(
            committed ? 1 : 0,
            new ApprovedNodeRegistry(fixture.Data).ListApproved().Count
        );
    }
}
