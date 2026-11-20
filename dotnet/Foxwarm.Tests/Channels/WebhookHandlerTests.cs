using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using static Foxwarm.Tests.WebhookHttpTests;

namespace Foxwarm.Tests;

public sealed class WebhookHandlerTests
{
    [Fact]
    public void Action_script_and_wake_are_validated_with_the_surface()
    {
        var parsed = AccessConfiguration.Normalize(
            Access(
                """
                handler:
                  token: a
                  surfaces:
                    webhook:
                      session: main
                      verify: bearer
                      action: toolscript
                      script: {filePath: hooks/ci.py, args: {repo: x}, timeoutSecs: 20}
                quiet:
                  token: b
                  surfaces:
                    webhook: {session: main, verify: bearer, wake: false}
                plain:
                  token: c
                  surfaces:
                    webhook: {session: main, verify: bearer}
                """
            )
        );
        var handler = parsed["handler"].Webhook!;
        Assert.Equal(WebhookAction.ToolScript, handler.Action);
        Assert.Equal("hooks/ci.py", SessionWait.Text(handler.Script!["filePath"]));
        Assert.Equal("foreground", SessionWait.Text(handler.Script["mode"]));
        Assert.Equal("x", SessionWait.Text(handler.Script["args"]!["repo"]));
        Assert.False(parsed["quiet"].Webhook!.Wake);
        Assert.True(parsed["plain"].Webhook!.Wake);
        Assert.Equal(WebhookAction.Message, parsed["plain"].Webhook!.Action);
        Assert.False(parsed["plain"].Webhook!.SameAs(parsed["quiet"].Webhook!));

        foreach (
            var invalid in new[]
            {
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: run}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, script: {code: 'print(1)'}}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript, script: {code: 'print(1)'}, wake: false}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, wake: 'no'}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript, script: {code: 'print(1)', mode: background}}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript, script: {args: {}}}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript, script: {code: 'print(1)', args: {webhook: 1}}}}}",
                "x: {token: a, surfaces: {webhook: {session: main, verify: bearer, action: toolscript, script: {code: 'print(1)', timeoutSecs: 0}}}}",
            }
        )
            Assert.Throws<InvalidDataException>(() =>
                AccessConfiguration.Normalize(Access(invalid))
            );
    }

    private static async Task Until(Func<bool> ready, string label)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!ready() && DateTime.UtcNow < deadline)
            await Task.Delay(10);
        Assert.True(ready(), label);
    }

    private static JsonArray Deliveries(WebhookActivity activity, string id) =>
        activity.Status(id)["deliveries"]!.AsArray();

    private static string? Outcome(WebhookActivity activity, string id, int index = 0) =>
        SessionWait.Text(Deliveries(activity, id)[index]?["outcome"]);

    [Fact]
    public async Task Handler_lanes_serialize_bound_deduplicate_and_drain()
    {
        var activity = new WebhookActivity();
        var notices = 0;
        activity.Changed += () => Interlocked.Increment(ref notices);
        var started = new List<string>();
        var first = new TaskCompletionSource<JsonObject?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Func<Task<JsonObject?>> Run(string name, Task<JsonObject?> result) =>
            () =>
            {
                lock (started)
                    started.Add(name);
                return result;
            };

        Assert.Equal(
            WebhookHandlerAdmission.Queued,
            activity.EnqueueHandler("a", "push", null, "d1", "main", Run("one", first.Task))
        );
        Assert.Equal(
            WebhookHandlerAdmission.Queued,
            activity.EnqueueHandler(
                "a",
                "push",
                null,
                "d2",
                "main",
                Run(
                    "two",
                    Task.FromResult<JsonObject?>(
                        new() { ["status"] = "completed", ["runId"] = "tsr_two" }
                    )
                )
            )
        );
        await Until(() => Outcome(activity, "a", 1) == "running", "first handler running");
        // The second waits behind the first; another identity has its own lane.
        Assert.Equal(new[] { "one" }, started);
        Assert.Equal("queued", Outcome(activity, "a"));
        Assert.Equal(
            WebhookHandlerAdmission.Duplicate,
            activity.EnqueueHandler("a", "push", null, "d1", "main", Run("dup", first.Task))
        );
        Assert.Equal(
            WebhookHandlerAdmission.Queued,
            activity.EnqueueHandler(
                "b",
                null,
                null,
                null,
                "main",
                Run("other", Task.FromResult<JsonObject?>(new() { ["status"] = "waiting" }))
            )
        );
        await Until(() => Outcome(activity, "b") == "paused", "other identity ran");

        first.SetResult(
            new JsonObject
            {
                ["status"] = "failed",
                ["runId"] = "tsr_one",
                ["error"] = new JsonObject { ["message"] = "boom" },
            }
        );
        await Until(() => Outcome(activity, "a") == "completed", "second handler ran");
        var history = Deliveries(activity, "a");
        Assert.Equal("tsr_two", SessionWait.Text(history[0]!["runId"]));
        Assert.Equal("failed", SessionWait.Text(history[1]!["outcome"]));
        Assert.Equal("boom", SessionWait.Text(history[1]!["error"]));
        Assert.Equal("main", activity.RunOwner("a", "tsr_one"));
        // A failed delivery can be redelivered; a completed one stays a duplicate.
        var retry = new TaskCompletionSource<JsonObject?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Assert.Equal(
            WebhookHandlerAdmission.Queued,
            activity.EnqueueHandler("a", "push", null, "d1", "main", () => retry.Task)
        );
        Assert.Equal(
            WebhookHandlerAdmission.Duplicate,
            activity.EnqueueHandler("a", "push", null, "d2", "main", () => retry.Task)
        );
        retry.SetResult(new JsonObject { ["status"] = "completed" });
        await Until(() => Outcome(activity, "a") == "completed", "retried handler ran");
        Assert.Equal(
            WebhookHandlerAdmission.Duplicate,
            activity.EnqueueHandler("a", "push", null, "d1", "main", () => retry.Task)
        );
        Assert.Null(activity.RunOwner("b", "tsr_one"));
        // The other identity ran while the first lane was still blocked.
        Assert.Equal(new[] { "one", "other", "two" }, started);

        // Failed verification is counted but never listed.
        activity.Unauthorized("a");
        Assert.Equal(1, activity.Status("a")["unauthorized"]!.GetValue<int>());
        Assert.Equal(3, Deliveries(activity, "a").Count);

        // Pending runs are bounded per identity.
        var blocker = new TaskCompletionSource<JsonObject?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Assert.Equal(
            WebhookHandlerAdmission.Queued,
            activity.EnqueueHandler("c", null, null, null, "main", () => blocker.Task)
        );
        await Until(() => Outcome(activity, "c") == "running", "blocker running");
        for (var index = 0; index < WebhookActivity.PendingLimit; index++)
            Assert.Equal(
                WebhookHandlerAdmission.Queued,
                activity.EnqueueHandler(
                    "c",
                    null,
                    null,
                    null,
                    "main",
                    () => throw new InvalidOperationException("never")
                )
            );
        Assert.Equal(
            WebhookHandlerAdmission.Full,
            activity.EnqueueHandler("c", null, null, null, "main", () => blocker.Task)
        );
        Assert.Equal(
            WebhookActivity.PendingLimit,
            activity.Status("c")["pending"]!.GetValue<int>()
        );

        // Drain fails pending runs, waits for the running one and refuses new work.
        var drained = activity.DrainAsync();
        Assert.False(drained.IsCompleted);
        Assert.Equal(
            WebhookHandlerAdmission.Closed,
            activity.EnqueueHandler("a", null, null, null, "main", () => blocker.Task)
        );
        blocker.SetResult(null);
        await drained.WaitAsync(TimeSpan.FromSeconds(10));
        var lane = Deliveries(activity, "c");
        Assert.Equal(WebhookActivity.HistoryLimit, lane.Count);
        Assert.All(
            lane,
            entry =>
            {
                Assert.Equal("failed", SessionWait.Text(entry!["outcome"]));
                Assert.Equal(
                    "Foxwarm stopped before the handler ran.",
                    SessionWait.Text(entry["error"])
                );
            }
        );
        Assert.True(notices > 0);

        // Idle state of identities removed from configuration is forgotten.
        activity.Retain(new HashSet<string>(["a"]));
        Assert.Equal(0, Deliveries(activity, "b").Count);
        Assert.Equal(3, Deliveries(activity, "a").Count);
    }

    private const string Identities = """
        handler:
          token: synthetic-handler
          surfaces:
            webhook:
              session: main
              verify: bearer
              action: toolscript
              script:
                code: "hook = args['webhook']\nprint('HANDLED', hook['id'], hook['payload']['marker'], hook['contentType'], args['extra'])"
                args: {extra: from-config}
        ghscript:
          token: synthetic-ghscript
          surfaces:
            webhook:
              session: main
              verify: github
              action: toolscript
              script: {code: "print('GH', args['webhook']['event'], args['webhook']['deliveryId'])"}
        quiet:
          token: synthetic-quiet
          surfaces:
            webhook: {session: main, verify: bearer, wake: false}
        loud:
          token: synthetic-loud
          surfaces:
            webhook: {session: main, verify: bearer}
        """;

    [Fact]
    public async Task Handlers_run_in_the_target_Session_and_passive_deliveries_wait_for_its_next_turn()
    {
        if (!Foxwarm.ToolScript.MontyWorker.IsSupported)
            return;
        using var temp = new TempDirectory();
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                    )
                )
        );
        var data = await WriteDataAsync(
            temp,
            provider.BaseUri,
            "bot: {enableWebUI: false, enableTrigger: false}",
            Identities
        );
        var config = new ModelConfiguration(HostPaths.ForDataRoot(data));
        await SeedMainAsync(data, config, provider.BaseUri);
        var settings = Ephemeral(await HttpServerSettings.CaptureAsync(config, data));
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var client = Client(host);
        using var admin = Client(host);
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        async Task<JsonObject> Hook(string id) =>
            (await Json(await admin.GetAsync("/api/webhooks")))["webhooks"]!
                .AsArray()
                .OfType<JsonObject>()
                .Single(row => SessionWait.Text(row["id"]) == id);
        async Task<JsonObject> Settled(string id, int count)
        {
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (true)
            {
                var row = await Hook(id);
                var deliveries = row["deliveries"]!.AsArray();
                if (
                    deliveries.Count >= count
                    && deliveries.All(entry =>
                        SessionWait.Text(entry?["outcome"]) is not ("queued" or "running")
                    )
                )
                    return row;
                Assert.True(DateTime.UtcNow < deadline, row.ToJsonString());
                await Task.Delay(50);
            }
        }

        // The handler runs without a model turn and sees the delivery plus configured args.
        Assert.Equal(
            HttpStatusCode.Accepted,
            (
                await Post(
                    client,
                    "/webhooks/handler",
                    "{\"marker\":\"HANDLER-MARK\"}"u8.ToArray(),
                    "application/json; charset=utf-8",
                    ("Authorization", "Bearer synthetic-handler")
                )
            ).StatusCode
        );
        var handler = await Settled("handler", 1);
        var run = handler["deliveries"]![0]!.AsObject();
        Assert.Equal("completed", SessionWait.Text(run["outcome"]));
        Assert.Equal("main", SessionWait.Text(run["sessionId"]));
        var runId = SessionWait.Text(run["runId"])!;
        var record = await Json(await admin.GetAsync($"/api/webhooks/handler/runs/{runId}"));
        Assert.Equal("main", SessionWait.Text(record["run"]!["ownerSessionId"]));
        Assert.Contains(
            "HANDLED handler HANDLER-MARK application/json from-config",
            SessionWait.Text(record["run"]!["stdout"])
        );
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await admin.GetAsync($"/api/webhooks/ghscript/runs/{runId}")).StatusCode
        );

        // GitHub delivery IDs deduplicate handler runs too.
        var push = "{\"ref\":\"main\"}"u8.ToArray();
        Assert.Equal(
            HttpStatusCode.Accepted,
            (await GitHub(client, "ghscript", "synthetic-ghscript", "push", push, "g-1")).StatusCode
        );
        var again = await GitHub(client, "ghscript", "synthetic-ghscript", "push", push, "g-1");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.True((await Json(again))["duplicate"]!.GetValue<bool>());
        var github = await Settled("ghscript", 2);
        Assert.Equal(
            new string?[] { "duplicate", "completed" },
            github["deliveries"]!.AsArray().Select(entry => SessionWait.Text(entry?["outcome"]))
        );

        // A non-waking delivery is saved without starting a turn ...
        Assert.Equal(
            HttpStatusCode.Accepted,
            (
                await Post(
                    client,
                    "/webhooks/quiet",
                    "QUIET-MARK"u8.ToArray(),
                    "text/plain",
                    ("Authorization", "Bearer synthetic-quiet")
                )
            ).StatusCode
        );
        await Task.Delay(300);
        Assert.Equal(0, provider.RequestCount);
        // ... and is read with the next turn.
        Assert.Equal(
            HttpStatusCode.Accepted,
            (
                await Post(
                    client,
                    "/webhooks/loud",
                    "LOUD-MARK"u8.ToArray(),
                    "text/plain",
                    ("Authorization", "Bearer synthetic-loud")
                )
            ).StatusCode
        );
        var request = await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(request.Body.IndexOf("QUIET-MARK", StringComparison.Ordinal) >= 0);
        Assert.True(
            request.Body.IndexOf("QUIET-MARK", StringComparison.Ordinal)
                < request.Body.IndexOf("LOUD-MARK", StringComparison.Ordinal)
        );

        // Status is administrator-only, describes each webhook and never includes secrets.
        var status = await admin.GetAsync("/api/webhooks");
        var text = await status.Content.ReadAsStringAsync();
        foreach (
            var secret in new[]
            {
                "synthetic-handler",
                "synthetic-ghscript",
                "synthetic-quiet",
                "synthetic-loud",
            }
        )
            Assert.DoesNotContain(secret, text);
        var quiet = await Hook("quiet");
        Assert.False(quiet["wake"]!.GetValue<bool>());
        Assert.Equal("delivered", SessionWait.Text(quiet["deliveries"]![0]!["outcome"]));
        Assert.EndsWith("/webhooks/quiet", SessionWait.Text(quiet["url"]));
        Assert.Equal("main", SessionWait.Text(quiet["targetSessionId"]));
        Assert.Equal("github", SessionWait.Text((await Hook("ghscript"))["verify"]));
        Assert.Null(handler["script"]!["args"]);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await client.GetAsync("/api/webhooks")).StatusCode
        );
        using var hookCredential = Client(host);
        hookCredential.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-loud");
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await hookCredential.GetAsync("/api/webhooks")).StatusCode
        );

        // A wrong secret is counted, not listed.
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (
                await Post(
                    client,
                    "/webhooks/loud",
                    "x"u8.ToArray(),
                    "text/plain",
                    ("Authorization", "Bearer wrong")
                )
            ).StatusCode
        );
        var loud = await Hook("loud");
        Assert.Equal(1, loud["unauthorized"]!.GetValue<int>());
        Assert.Single(loud["deliveries"]!.AsArray());
    }
}
