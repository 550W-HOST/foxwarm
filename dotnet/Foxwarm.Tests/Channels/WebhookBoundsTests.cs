using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using static Foxwarm.Tests.WebhookHttpTests;

namespace Foxwarm.Tests;

// Bounds on unauthenticated work, passive backlogs, status notices and model-reachable
// configuration for inbound webhooks.
public sealed class WebhookBoundsTests
{
    [Fact]
    public void Unverified_reads_are_bounded_per_identity_and_overall()
    {
        var http = new WebhookHttp(new AccessConfiguration(new JsonObject()), null!);
        for (var index = 0; index < WebhookHttp.UnverifiedReadsPerIdentity; index++)
            Assert.True(http.TryEnterUnverified("a"));
        Assert.False(http.TryEnterUnverified("a"));
        foreach (var id in new[] { "b", "c", "d" })
            for (var index = 0; index < WebhookHttp.UnverifiedReadsPerIdentity; index++)
                Assert.True(http.TryEnterUnverified(id));
        Assert.Equal(32, WebhookHttp.UnverifiedReadsTotal);
        Assert.False(http.TryEnterUnverified("e"));
        http.ExitUnverified("a");
        Assert.True(http.TryEnterUnverified("e"));
        Assert.False(http.TryEnterUnverified("a"));
    }

    private static QueueItem Passive(string id, string? text = "x") =>
        WebhookHttp.Frame(id, null, null, null, text) with
        {
            Trigger = false,
        };

    [Fact]
    public void Passive_backlog_counts_only_this_webhooks_unread_passive_items()
    {
        var candidate = Passive("quiet");
        WebhookHttp.PassiveBacklog Backlog(IEnumerable<QueueItem> queue, QueueItem? next = null) =>
            WebhookHttp.Backlog(queue.ToList(), "quiet", next ?? candidate);

        Assert.Equal(WebhookHttp.PassiveBacklog.Within, Backlog([]));
        Assert.Equal(
            WebhookHttp.PassiveBacklog.Within,
            Backlog(Enumerable.Repeat(Passive("quiet"), WebhookHttp.PassiveCountLimit - 1))
        );
        Assert.Equal(
            WebhookHttp.PassiveBacklog.OverSoft,
            Backlog(Enumerable.Repeat(Passive("quiet"), WebhookHttp.PassiveCountLimit))
        );
        // Another webhook (even one whose ID extends this one) and waking items do not count.
        var others = Enumerable
            .Repeat(Passive("quiet2"), 40)
            .Concat(Enumerable.Repeat(WebhookHttp.Frame("quiet", null, null, null, "x"), 40));
        Assert.Equal(WebhookHttp.PassiveBacklog.Within, Backlog(others));

        // Payload bytes: the candidate may fill the budget exactly, not exceed it.
        var four = Enumerable.Repeat(Passive("quiet", new string('a', 60_000)), 4).ToList();
        var rest = WebhookHttp.PassiveByteLimit - 240_000;
        Assert.Equal(
            WebhookHttp.PassiveBacklog.Within,
            Backlog(four, Passive("quiet", new string('b', rest)))
        );
        Assert.Equal(
            WebhookHttp.PassiveBacklog.OverSoft,
            Backlog(four, Passive("quiet", new string('b', rest + 1)))
        );

        // Metadata-only items still count toward the hard bound.
        var omitted = Passive("quiet", null);
        Assert.DoesNotContain(omitted.Parts!, part => part.ContainsKey("text"));
        Assert.Contains(
            omitted.Parts!,
            part => SessionWait.Text(part["system"]) == WebhookHttp.OmittedNotice
        );
        Assert.Equal(
            WebhookHttp.PassiveBacklog.OverSoft,
            Backlog(Enumerable.Repeat(omitted, WebhookHttp.PassiveHardLimit - 1))
        );
        Assert.Equal(
            WebhookHttp.PassiveBacklog.Full,
            Backlog(Enumerable.Repeat(omitted, WebhookHttp.PassiveHardLimit))
        );
    }

    [Fact]
    public async Task Status_notices_are_coalesced_and_unverified_requests_raise_none()
    {
        var activity = new WebhookActivity(TimeSpan.FromMilliseconds(300));
        var notices = 0;
        activity.Changed += () => Interlocked.Increment(ref notices);
        for (var index = 0; index < 20; index++)
            activity.Record("a", "ignored", 200, "ping");
        Assert.Equal(1, notices);
        for (var index = 0; index < 20; index++)
            activity.Unauthorized("a");
        await Task.Delay(700);
        // One trailing notice carries every change made inside the interval.
        Assert.Equal(2, notices);
        Assert.Equal(20, activity.Status("a")["unauthorized"]!.GetValue<int>());
        for (var index = 0; index < 20; index++)
            activity.Unauthorized("a");
        await Task.Delay(400);
        Assert.Equal(2, notices);
        activity.Refused("a");
        Assert.Equal(3, notices);
        Assert.Equal(1, activity.Status("a")["refused"]!.GetValue<int>());
    }

    [Fact]
    public async Task Set_config_cannot_add_or_change_webhook_identities()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var baseRaw = f.Configuration.ReadCurrentAppRaw().TrimEnd();
        string Config(string identities) =>
            baseRaw
            + "\naccess:\n  identities:\n"
            + string.Join('\n', identities.Split('\n').Select(line => "    " + line))
            + "\n";
        const string hook = """
            hook:
              token: synthetic-hook
              surfaces:
                webhook: {session: main, verify: bearer}
            """;
        const string mcp = """
            client:
              token: synthetic-client
              surfaces:
                mcp: {}
            """;
        // Setup is the user's way to add a webhook.
        Assert.True(
            SessionCatalog.Flag((await f.Configuration.SaveAppAsync(Config(hook)))["saved"])
        );
        var candidate = Path.Combine(f.Work, "candidate.yaml");
        async Task<JsonNode?> SetConfig(string raw)
        {
            await File.WriteAllTextAsync(candidate, raw);
            return await f.ToolAsync(
                "set_config",
                new JsonObject { ["target"] = "config", ["filePath"] = candidate }
            );
        }
        async Task Refused(string raw)
        {
            var before = f.Configuration.ReadCurrentAppRaw();
            var result = await SetConfig(raw);
            Assert.Equal(
                "set_config cannot add or change webhook identities. Ask the user to configure webhooks in Setup.",
                SessionWait.Text(result?["error"]?["message"])
            );
            Assert.Equal(before, f.Configuration.ReadCurrentAppRaw());
        }

        // Keeping the webhook unchanged while changing something else is allowed.
        Assert.Null((await SetConfig(Config(hook + "\n" + mcp)))!["error"]);
        // Adding, converting, rotating or reconfiguring one is not.
        await Refused(
            Config(
                hook
                    + "\n"
                    + mcp
                    + """

                    other:
                      token: synthetic-other
                      surfaces:
                        webhook: {session: main, verify: bearer}
                    """
            )
        );
        await Refused(
            Config(
                hook
                    + """

                    client:
                      token: synthetic-client
                      surfaces:
                        webhook: {session: main, verify: bearer}
                    """
            )
        );
        await Refused(Config(hook.Replace("synthetic-hook", "synthetic-rotated") + "\n" + mcp));
        await Refused(
            Config(hook.Replace("verify: bearer", "verify: bearer, wake: false") + "\n" + mcp)
        );
        await Refused(
            Config(
                hook.Replace(
                    "verify: bearer}",
                    "verify: bearer, action: toolscript, script: {code: 'print(1)'}}"
                )
                    + "\n"
                    + mcp
            )
        );
        await Refused(Config(hook.Replace("session: main", "session: other") + "\n" + mcp));
        // Removing a webhook narrows exposure and remains possible.
        Assert.Null((await SetConfig(Config(mcp)))!["error"]);
        Assert.DoesNotContain("synthetic-hook", f.Configuration.ReadCurrentAppRaw());
        await Refused(Config(hook + "\n" + mcp));
    }

    private const string Identities = """
        hook:
          token: synthetic-hook
          surfaces:
            webhook: {session: main, verify: bearer}
        cf:
          token: synthetic-cf
          surfaces:
            webhook: {session: main, verify: {header: cf-webhook-auth}}
        gh:
          token: synthetic-gh
          surfaces:
            webhook: {session: main, verify: github}
        quiet:
          token: synthetic-quiet
          surfaces:
            webhook: {session: main, verify: bearer, wake: false}
        route:
          token: synthetic-route
          surfaces:
            webhook: {session: main, verify: bearer, wake: false}
        full:
          token: synthetic-full
          surfaces:
            webhook: {session: main, verify: bearer, wake: false}
        """;

    private static string Sign(string secret, byte[] body) =>
        "sha256="
        + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body));

    [Fact]
    public async Task Unverified_requests_are_refused_alike_and_backlogs_stay_bounded()
    {
        using var temp = new TempDirectory();
        // No delivery here wakes the Session, so no model request is expected.
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, _, _) => throw new InvalidOperationException("unexpected model request")
        );
        var data = await WriteDataAsync(
            temp,
            provider.BaseUri,
            "bot: {enableWebUI: false, enableTrigger: false}",
            Identities
        );
        var config = new ModelConfiguration(HostPaths.ForDataRoot(data));
        await SeedMainAsync(data, config, provider.BaseUri);
        // Seed the hard bound for "full" directly: a Session that never reads its backlog.
        await using (
            var seed = new SessionManager(
                data,
                config.Paths.AgentsRoot,
                new ResponsesClientOptions(provider.BaseUri, "wire", "local/wire", "", "", 713),
                config.Models,
                hostPaths: config.Paths
            )
        )
        {
            await seed.LoadMainHostAsync();
            var runtime = new SessionRuntime(seed);
            Assert.True(
                await runtime.SubmitWebhookAsync(
                    "main",
                    WebhookHttp.Frame("full", null, null, null, null),
                    null,
                    wake: false
                )
            );
        }
        // Copy that admitted item to the hard bound in the saved queue; admitting each one
        // through strict saves would take far longer.
        var document = Path.Combine(data, "state", "sessions", "main.json");
        var root = JsonNode.Parse(await File.ReadAllTextAsync(document))!.AsObject();
        var queued = root["queue"]!.AsArray();
        Assert.Single(queued);
        for (var index = 1; index < WebhookHttp.PassiveHardLimit; index++)
            queued.Add(queued[0]!.DeepClone());
        await File.WriteAllTextAsync(document, root.ToJsonString());
        var settings = Ephemeral(await HttpServerSettings.CaptureAsync(config, data));
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var client = Client(host);
        using var admin = Client(host);
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        async Task<JsonObject> Status(string id) =>
            (await Json(await admin.GetAsync("/api/webhooks")))["webhooks"]!
                .AsArray()
                .OfType<JsonObject>()
                .Single(row => SessionWait.Text(row["id"]) == id);

        // Every unauthenticated request gets the same 401 before any size answer: unknown IDs,
        // missing secrets, and GitHub bodies that are too large to verify.
        var oversized = new byte[WebhookHttp.BodyLimit + 1];
        foreach (var id in new[] { "unknown", "hook", "cf", "gh" })
        {
            var response = await Post(client, "/webhooks/" + id, oversized, "application/json");
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.Equal("Unauthorized", (await Json(response))["error"]!.GetValue<string>());
        }
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (
                await Post(
                    client,
                    "/webhooks/gh",
                    oversized,
                    "application/json",
                    ("X-Hub-Signature-256", Sign("synthetic-gh", oversized)),
                    ("X-GitHub-Event", "push")
                )
            ).StatusCode
        );
        // A missing or malformed signature is refused before the body is read.
        var ping = "{}"u8.ToArray();
        foreach (
            var signature in new[]
            {
                null,
                "sha1=" + new string('0', 40),
                Sign("synthetic-gh", ping)[..^2],
                "sha256=" + new string('z', 64),
            }
        )
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (
                    await Post(
                        client,
                        "/webhooks/gh",
                        ping,
                        "application/json",
                        [
                            ("X-GitHub-Event", "ping"),
                            .. signature is null
                                ? []
                                : new[] { ("X-Hub-Signature-256", signature) },
                        ]
                    )
                ).StatusCode
            );
        var github = await Status("gh");
        Assert.Equal(6, github["unauthorized"]!.GetValue<int>());
        Assert.Empty(github["deliveries"]!.AsArray());
        // An authenticated sender still learns that its body is too large.
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (
                await Post(
                    client,
                    "/webhooks/hook",
                    oversized,
                    "text/plain",
                    ("Authorization", "Bearer synthetic-hook")
                )
            ).StatusCode
        );

        // Letter case and a trailing slash reach the webhook; its ID is matched exactly.
        var route = ("Authorization", "Bearer synthetic-route");
        foreach (var path in new[] { "/Webhooks/route", "/webhooks/route/" })
            Assert.Equal(
                HttpStatusCode.Accepted,
                (await Post(client, path, "ROUTE"u8.ToArray(), "text/plain", route)).StatusCode
            );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await Post(client, "/webhooks/ROUTE", "x"u8.ToArray(), "text/plain", route)).StatusCode
        );
        Assert.Equal(2, (await Status("route"))["deliveries"]!.AsArray().Count);

        // Passive deliveries past the soft bound keep only their metadata.
        var quiet = ("Authorization", "Bearer synthetic-quiet");
        for (var index = 0; index <= WebhookHttp.PassiveCountLimit; index++)
            Assert.Equal(
                HttpStatusCode.Accepted,
                (
                    await Post(
                        client,
                        "/webhooks/quiet",
                        Encoding.UTF8.GetBytes($"QUIET-{index}-END"),
                        "text/plain",
                        quiet
                    )
                ).StatusCode
            );
        var quietStatus = await Status("quiet");
        var latest = quietStatus["deliveries"]![0]!;
        Assert.Equal("delivered", SessionWait.Text(latest["outcome"]));
        Assert.True(latest["payloadOmitted"]!.GetValue<bool>());
        Assert.Null(quietStatus["deliveries"]![1]!["payloadOmitted"]);
        var authority = await File.ReadAllTextAsync(
            Path.Combine(data, "state", "sessions", "main.json")
        );
        Assert.Contains($"QUIET-{WebhookHttp.PassiveCountLimit - 1}-END", authority);
        Assert.DoesNotContain($"QUIET-{WebhookHttp.PassiveCountLimit}-END", authority);

        // At the hard bound passive deliveries are refused and counted, not listed.
        var refused = await Post(
            client,
            "/webhooks/full",
            "x"u8.ToArray(),
            "text/plain",
            ("Authorization", "Bearer synthetic-full")
        );
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(60), refused.Headers.RetryAfter?.Delta);
        var full = await Status("full");
        Assert.Equal(1, full["refused"]!.GetValue<int>());
        Assert.Empty(full["deliveries"]!.AsArray());
        Assert.Equal(0, provider.RequestCount);

        // Concurrent unverified reads are bounded, and a stalled body is dropped at the deadline.
        var origin = client.BaseAddress!;
        var stalled = new List<TcpClient>();
        try
        {
            for (var index = 0; index < WebhookHttp.UnverifiedReadsPerIdentity; index++)
            {
                var socket = new TcpClient();
                await socket.ConnectAsync(origin.Host, origin.Port);
                var head = Encoding.ASCII.GetBytes(
                    "POST /webhooks/gh HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                        + $"X-Hub-Signature-256: sha256={new string('0', 64)}\r\nX-GitHub-Event: push\r\n"
                        + $"Content-Length: {WebhookHttp.BodyLimit}\r\n\r\n"
                );
                await socket.GetStream().WriteAsync(head);
                // Most of the body arrives at once, so Kestrel's minimum data rate is satisfied
                // for a long time; only the route's own deadline ends the read.
                await socket.GetStream().WriteAsync(new byte[WebhookHttp.BodyLimit - 16]);
                stalled.Add(socket);
            }
            await Task.Delay(500);
            var signed = await GitHub(client, "gh", "synthetic-gh", "ping", ping);
            Assert.Equal(HttpStatusCode.Unauthorized, signed.StatusCode);
            var started = DateTime.UtcNow;
            foreach (var socket in stalled)
            {
                using var reader = new StreamReader(socket.GetStream(), Encoding.ASCII);
                var line = await reader
                    .ReadLineAsync()
                    .WaitAsync(WebhookHttp.ReadDeadline + TimeSpan.FromSeconds(10));
                Assert.StartsWith("HTTP/1.1 401", line);
                await reader.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            Assert.True(
                DateTime.UtcNow - started < WebhookHttp.ReadDeadline + TimeSpan.FromSeconds(5)
            );
            Assert.Equal(
                HttpStatusCode.OK,
                (await GitHub(client, "gh", "synthetic-gh", "ping", ping)).StatusCode
            );
            // A sender that stalls at once is ended by Kestrel's minimum data rate; it gets
            // the same answer.
            using var early = new TcpClient();
            await early.ConnectAsync(origin.Host, origin.Port);
            await early
                .GetStream()
                .WriteAsync(
                    Encoding.ASCII.GetBytes(
                        "POST /webhooks/gh HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                            + $"X-Hub-Signature-256: sha256={new string('0', 64)}\r\nX-GitHub-Event: push\r\n"
                            + "Content-Length: 1000\r\n\r\n{"
                    )
                );
            using var earlyReader = new StreamReader(early.GetStream(), Encoding.ASCII);
            Assert.StartsWith(
                "HTTP/1.1 401",
                await earlyReader
                    .ReadLineAsync()
                    .WaitAsync(WebhookHttp.ReadDeadline + TimeSpan.FromSeconds(10))
            );
        }
        finally
        {
            foreach (var socket in stalled)
                socket.Dispose();
        }
    }
}
