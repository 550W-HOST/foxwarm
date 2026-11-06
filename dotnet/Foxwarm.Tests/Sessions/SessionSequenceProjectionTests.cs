using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class SessionSequenceProjectionTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Final() =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = "done" }
            ),
        };

    private static Task Respond(System.Net.Sockets.NetworkStream stream, JsonArray output) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = output },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "wire", "a", "", "", 713);

    private static IEnumerable<JsonObject> Objects(JsonNode? array) =>
        (array as JsonArray)?.OfType<JsonObject>() ?? [];

    private static string? Text(JsonNode? node) => SessionWait.Text(node);

    private static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [Fact]
    public async Task Real_deliveries_pair_exactly_and_project_lanes_live_updates_and_scope()
    {
        string a = "",
            b = "";
        var ownerRequests = -1;
        await using var peer = new ScriptedResponsesSequenceServer(
            30,
            async (_, stream, request) =>
                await Respond(
                    stream,
                    !request.Body.Contains("deliver everything", StringComparison.Ordinal)
                        ? new JsonArray(Final())
                        : Interlocked.Increment(ref ownerRequests) switch
                        {
                            0 => new JsonArray(
                                Call(
                                    "p1",
                                    "send_to_session",
                                    new() { ["sessionId"] = a, ["message"] = "hello a" }
                                ),
                                Call(
                                    "p2",
                                    "run_script",
                                    new()
                                    {
                                        ["code"] =
                                            $"call_tool('send_to_session', {{'sessionId': '{b}', 'message': 'one'}})\ncall_tool('send_to_session', {{'sessionId': '{b}', 'message': 'two'}})\nreturn 1",
                                    }
                                ),
                                Call(
                                    "p3",
                                    "create_child_session",
                                    new() { ["suffix"] = "kid", ["message"] = "child start" }
                                )
                            ),
                            1 => new JsonArray(
                                Call(
                                    "t1",
                                    "task",
                                    new()
                                    {
                                        ["action"] = "create",
                                        ["title"] = "Check the sequence",
                                        ["ownerSessionId"] = a,
                                        ["notifySession"] = true,
                                    }
                                )
                            ),
                            _ => new JsonArray(Final()),
                        }
                )
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        var targetA = await f.Manager.CreateNamedAsync("main", "peer-a", null, null);
        var targetB = await f.Manager.CreateNamedAsync("main", "peer-b", null, null);
        var unrelated = await f.Manager.CreateNamedAsync("main", "unrelated", null, null);
        targetA.Registry.TriggerOverride = _ => Task.CompletedTask;
        targetB.Registry.TriggerOverride = _ => Task.CompletedTask;
        a = targetA.Id;
        b = targetB.Id;
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("deliver everything"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(20));
        await targetA.Registry.Runner.ProcessQueueAsync(a).WaitAsync(TimeSpan.FromSeconds(20));
        await unrelated.Entry.SaveLane.AdmitAsync(QueueItem.UserText("alone"), SaveKind.Strict);
        await unrelated
            .Registry.Runner.ProcessQueueAsync(unrelated.Id)
            .WaitAsync(TimeSpan.FromSeconds(20));
        var kid = f
            .Manager.LocalProjections()
            .Select(row => Text(row["id"])!)
            .Single(id => id.EndsWith("kid", StringComparison.Ordinal));
        await (await f.Manager.RequiredAsync(kid))
            .Registry.Runner.ProcessQueueAsync(kid)
            .WaitAsync(TimeSpan.FromSeconds(20));

        var runtime = new SessionRuntime(f.Manager);
        var projection = new SessionSequenceProjection(runtime, f.Manager.ArchiveDatabase);
        var batch = (long)
            SessionWait.Number(
                f
                    .Owner.History()
                    .First(message =>
                        Text(message["role"]) == "model" && Objects(message["parts"]).Count() == 3
                    )["__meta"]!["seq"]
            )!;

        var all = projection.BuildPage(new(), null);
        var lanes = Objects(all["sessions"]).Select(row => Text(row["id"])!).ToArray();
        Assert.Contains(f.Owner.Id, lanes);
        Assert.Contains(a, lanes);
        // Messages to b are still queued, so b has no rows yet and appears as a peer.
        Assert.DoesNotContain(b, lanes);
        Assert.Contains(Objects(all["peers"]), peer => Text(peer["id"]) == b);
        Assert.Contains(kid, lanes);
        Assert.Contains(unrelated.Id, lanes);
        var links = Objects(all["links"]).ToArray();

        var toA = links.Single(link => Text(link["deliverySeq"]) == $"{batch}.1");
        Assert.Equal("exact", Text(toA["pairing"]));
        Assert.Equal(f.Owner.Id, Text(toA["from"]!["sessionId"]));
        Assert.Equal(batch, SessionWait.Number(toA["from"]!["seq"]));
        Assert.Equal(1, SessionWait.Number(toA["from"]!["call"]));
        Assert.Equal(a, Text(toA["to"]!["sessionId"]));
        Assert.NotNull(toA["consumedAt"]);
        Assert.True(SessionWait.Number(toA["consumedAt"]) >= SessionWait.Number(toA["sentAt"]));

        var toB = links
            .Where(link => Text(link["to"]!["sessionId"]) == b)
            .OrderBy(link => Text(link["deliverySeq"]))
            .ToArray();
        Assert.Equal(
            new[] { $"{batch}.2.1", $"{batch}.2.2" },
            toB.Select(link => Text(link["deliverySeq"]))
        );
        Assert.All(toB, link => Assert.Equal("queued", Text(link["state"])));
        Assert.All(toB, link => Assert.Null(link["consumedAt"]));
        Assert.Equal(2, SessionWait.Number(toB[1]["from"]!["sub"]));

        var task = links.Single(link => Text(link["kind"]) == "task");
        Assert.Equal("exact", Text(task["pairing"]));
        Assert.Equal("assigned", Text(task["taskEvent"]));
        var taskId = Text(task["taskId"])!;
        Assert.Equal("Check the sequence", Text(all["tasks"]![taskId]!["title"]));

        var spawn = links.Single(link => Text(link["kind"]) == "spawn");
        Assert.Equal(kid, Text(spawn["to"]!["sessionId"]));
        Assert.Equal("exact", Text(spawn["pairing"]));
        Assert.Equal(3, SessionWait.Number(spawn["from"]!["call"]));
        var kidMessage = links.Single(link => Text(link["deliverySeq"]) == $"{batch}.3");
        Assert.Equal(kid, Text(kidMessage["to"]!["sessionId"]));
        Assert.Equal("exact", Text(kidMessage["pairing"]));

        Assert.Contains(
            links,
            link =>
                Text(link["kind"]) == "user"
                && Text(link["to"]!["sessionId"]) == f.Owner.Id
                && Text(link["preview"]) == "deliver everything"
        );
        var ownerEvents = Objects(all["events"])
            .Where(item => Text(item["sessionId"]) == f.Owner.Id)
            .ToArray();
        Assert.Equal(3, ownerEvents.Count(item => Text(item["kind"]) == "llm"));
        var script = ownerEvents.Single(item => Text(item["name"]) == "run_script");
        Assert.Equal($"{batch}.2", Text(script["deliverySeq"]));
        Assert.Equal(2, Objects(script["subCalls"]).Count());
        Assert.All(
            ownerEvents.Where(item => Text(item["kind"]) == "tool"),
            item =>
                Assert.True(SessionWait.Number(item["end"]) >= SessionWait.Number(item["start"]))
        );

        // Incremental refresh appends only rows after the client's cursor.
        var cursor = (long)SessionWait.Number(all["cursors"]![a])!;
        await f.Manager.SendAsync(targetB, a, "later news");
        await targetA.Registry.Runner.ProcessQueueAsync(a).WaitAsync(TimeSpan.FromSeconds(20));
        var delta = projection.BuildIncremental(
            new(Now, new Dictionary<string, long> { [a] = cursor }, SessionIds: [a]),
            null
        );
        Assert.Equal("incremental", Text(delta["mode"]));
        Assert.All(
            Objects(delta["events"]),
            item => Assert.True(SessionWait.Number(item["seq"]) > cursor)
        );
        var later = Assert.Single(
            Objects(delta["links"]),
            link => Text(link["preview"]) == "later news"
        );
        Assert.Equal(b, Text(later["from"]!["sessionId"]));
        Assert.True(later["from"]!["outside"]!.GetValue<bool>());
        Assert.Equal("inferred", Text(later["pairing"]));

        // A scoped caller sees only allowed lanes; other peers are opaque endpoints.
        var scoped = projection.BuildPage(
            new(),
            new(
                id => id == a,
                id => "external:" + id.Length.ToString(CultureInfo.InvariantCulture),
                row => new JsonObject { ["id"] = row["id"]!.DeepClone() }
            )
        );
        Assert.Equal(new[] { a }, Objects(scoped["sessions"]).Select(row => Text(row["id"])));
        Assert.Null(scoped["tasks"]);
        var scopedText = scoped.ToJsonString();
        Assert.DoesNotContain(f.Owner.Id, scopedText);
        Assert.DoesNotContain(
            "one",
            Objects(scoped["links"]).Select(link => Text(link["preview"]))
        );
        Assert.All(
            Objects(scoped["peers"]),
            item =>
            {
                Assert.True(item["opaque"]!.GetValue<bool>());
                Assert.Null(item["displayName"]);
            }
        );
        Assert.Contains(
            Objects(scoped["links"]),
            link =>
                Text(link["deliverySeq"]) == $"{batch}.1"
                && Text(link["from"]!["sessionId"])!
                    .StartsWith("external:", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Legacy_deliveries_without_an_ID_pair_by_target_time_and_body_and_are_inferred()
    {
        await using var f = await ScriptFixture.Create();
        var sender = f.Owner;
        var receiver = await f.Manager.CreateNamedAsync("main", "receiver", null, null);
        var t0 = (long)Now - 60_000;
        string Time(long at) =>
            DateTimeOffset
                .FromUnixTimeMilliseconds(at)
                .ToOffset(TimeSpan.FromHours(8))
                .ToString("yyyy-MM-dd HH:mm:ss +0800", CultureInfo.InvariantCulture);
        await Append(
            sender,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "start" }),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 - 1000 },
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "c1",
                            ["name"] = "send_to_session",
                            ["args"] = new JsonObject
                            {
                                ["sessionId"] = receiver.Id,
                                ["message"] = "legacy hello",
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = t0,
                    ["llmRequestTiming"] = new JsonObject
                    {
                        ["startedAt"] = t0 - 500,
                        ["completedAt"] = t0,
                        ["durationMs"] = 500,
                    },
                },
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "c1",
                            ["name"] = "send_to_session",
                            ["response"] = new JsonObject { ["output"] = "Message sent" },
                            ["executionTiming"] = new JsonObject
                            {
                                ["startedAt"] = t0 + 10,
                                ["completedAt"] = t0 + 30,
                                ["durationMs"] = 20,
                            },
                            ["__meta"] = new JsonObject
                            {
                                ["sessionMessages"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["id"] = "c1",
                                        ["targetSessionId"] = receiver.Id,
                                        ["message"] = "legacy hello",
                                    }
                                ),
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 + 30 },
            }
        );
        JsonObject Wrapped(long sent, long consumed, string body) =>
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] =
                            $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{sender.Id}\" replyTargetSessionId=\"{sender.Id}\" replyVia=\"send_to_session\" time=\"{Time(sent)}\" hint=\"inter-agent message from another session, not direct end-user input\">\n{body}\n</foxwarm-message>",
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = consumed },
            };
        await Append(
            receiver,
            Wrapped(t0 + 10, t0 + 5000, "legacy hello"),
            Wrapped(t0 + 20_000, t0 + 21_000, "no sender evidence")
        );

        var projection = new SessionSequenceProjection(
            new SessionRuntime(f.Manager),
            f.Manager.ArchiveDatabase
        );
        var result = projection.BuildPage(new(), null);
        var links = Objects(result["links"])
            .Where(link => Text(link["kind"]) == "message")
            .ToArray();
        Assert.Equal(2, links.Length);
        var paired = links.Single(link => Text(link["preview"]) == "legacy hello");
        Assert.Equal("inferred", Text(paired["pairing"]));
        Assert.Null(paired["deliverySeq"]);
        Assert.Equal(t0 + 10, SessionWait.Number(paired["from"]!["at"]));
        Assert.NotNull(paired["from"]!["seq"]);
        Assert.Equal(t0 + 5000, SessionWait.Number(paired["consumedAt"]));
        var orphan = links.Single(link => Text(link["preview"]) == "no sender evidence");
        Assert.Equal("inferred", Text(orphan["pairing"]));
        Assert.Null(orphan["from"]!["seq"]);
        // The wrapper time has second resolution.
        Assert.InRange(SessionWait.Number(orphan["sentAt"])!.Value, t0 + 19_000, t0 + 20_000);
        // The matched send is not repeated as an unread delivery.
        Assert.DoesNotContain(Objects(result["links"]), link => link["state"] is not null);
    }

    [Fact]
    public async Task Assistant_text_carries_its_phase_and_user_input_shows_only_authored_content()
    {
        await using var f = await ScriptFixture.Create();
        var owner = f.Owner;
        var t0 = (long)Now - 60_000;
        JsonObject Model(long at, JsonArray parts, bool timed = true) =>
            new()
            {
                ["role"] = "model",
                ["parts"] = parts,
                ["__meta"] = timed
                    ? new JsonObject
                    {
                        ["timestamp"] = at,
                        ["llmRequestTiming"] = new JsonObject
                        {
                            ["startedAt"] = at - 100,
                            ["completedAt"] = at,
                        },
                    }
                    : new JsonObject { ["timestamp"] = at },
            };
        await Append(
            owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] =
                            "<foxwarm-message type=\"channel\" channelType=\"webui\" time=\"2026-11-02 10:00:00 +0800\" hint=\"direct user message via channel\">\nPlease review the patch\n</foxwarm-message>",
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 },
            },
            Model(
                t0 + 1000,
                new JsonArray(
                    new JsonObject { ["thinking"] = "private reasoning", ["text"] = "" },
                    new JsonObject { ["text"] = "Looking at it", ["phase"] = "commentary" },
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "x1",
                            ["name"] = "read",
                            ["args"] = new JsonObject { ["filePath"] = "a.txt" },
                        },
                    }
                )
            ),
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "x1",
                            ["name"] = "read",
                            ["response"] = new JsonObject { ["error"] = "missing" },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = t0 + 1100 },
            },
            Model(
                t0 + 2000,
                new JsonArray(new JsonObject { ["text"] = "Done", ["phase"] = "final_answer" })
            ),
            // Text rows without request timing (for example external runtime output) still show.
            Model(t0 + 3000, new JsonArray(new JsonObject { ["text"] = "Untimed" }), timed: false)
        );
        var result = new SessionSequenceProjection(
            new SessionRuntime(f.Manager),
            f.Manager.ArchiveDatabase
        ).BuildPage(new(), null);
        var texts = Objects(result["events"])
            .Where(item => Text(item["kind"]) == "llm")
            .Select(item => (Text(item["preview"]), Text(item["phase"])))
            .ToArray();
        Assert.Equal(
            new (string?, string?)[]
            {
                ("Looking at it", "commentary"),
                ("Done", "final_answer"),
                ("Untimed", null),
            },
            texts
        );
        Assert.DoesNotContain("private reasoning", result.ToJsonString());
        var tool = Objects(result["events"]).Single(item => Text(item["kind"]) == "tool");
        Assert.Equal(
            ("read", "a.txt", "error"),
            (Text(tool["name"]), Text(tool["preview"]), Text(tool["status"]))
        );
        var input = Objects(result["links"]).Single(link => Text(link["kind"]) == "user");
        Assert.Equal("Please review the patch", Text(input["preview"]));
    }

    internal static Task Append(SessionOwner owner, params JsonObject[] messages) =>
        owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                messages,
                [],
                updateLastMessageTime: true,
                finalizing: false,
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        );
}
