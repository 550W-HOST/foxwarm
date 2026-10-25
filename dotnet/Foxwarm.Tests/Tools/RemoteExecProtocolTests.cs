using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class RemoteExecProtocolTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal WebApplication App = null!;
        internal ClientWebSocket Socket = null!;
        internal JsonObject Credential = null!;
        internal int Wakes;
        internal Action<string, AtomicJsonWriteStage>? WriteStage;
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");

        internal async Task Start(
            bool legacy = false,
            bool cancel = true,
            bool advertiseExec = true
        )
        {
            Manager = new(Data, Work, Options, HostModels.ForTest(Options), authorityStageHook: (id, stage) => WriteStage?.Invoke(id, stage));
            await Manager.LoadAsync();
            Owner = await Manager.CreateNamedAsync("main", "exec-owner", null, null);
            Owner.Registry.TriggerOverride = _ =>
            {
                Wakes++;
                return Task.CompletedTask;
            };
            Credential = Manager.Nodes.Registry.Create("remote");
            await Connect(legacy, cancel, advertiseExec);
            await Manager.SelectNodeAsync(Owner, "remote");
        }

        internal async Task Connect(
            bool legacy = false,
            bool cancel = true,
            bool advertiseExec = true
        )
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            App = builder.Build();
            App.UseWebSockets();
            App.Map("/node_ws", Manager.Nodes.HandleAsync);
            await App.StartAsync();
            Socket = new();
            await Socket.ConnectAsync(
                new Uri(
                    App.Urls.Single().Replace("http", "ws")
                        + "/node_ws?id=remote&auth="
                        + Credential["authToken"]!.GetValue<string>()
                ),
                default
            );
            var definitions = new JsonArray(
                new JsonObject { ["name"] = "session", ["description"] = "peer collision" }
            );
            if (advertiseExec)
                definitions.Add(new JsonObject { ["name"] = "exec" });
            var registration = new JsonObject
            {
                ["type"] = "node_register",
                ["nodeType"] = "protocol-peer",
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = definitions,
                    ["features"] = new JsonObject
                    {
                        ["remoteExecBackgroundRegistration"] = true,
                        ["execWaitCancellation"] = cancel,
                    },
                },
            };
            if (!legacy)
                registration["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 };
            await Send(registration);
            Assert.Equal("registered", (await Read())["type"]!.GetValue<string>());
        }

        internal Task<JsonNode?> Exec(CancellationToken token = default) =>
            Manager.Nodes.ExecuteAsync(
                "remote",
                "exec",
                new JsonObject { ["command"] = "owned-effect" },
                Owner.Id,
                Owner.Agent,
                "remote",
                "C:\\remote\\cwd",
                false,
                token,
                Owner
            );

        internal async Task Send(JsonObject message) =>
            await Socket.SendAsync(
                Encoding.UTF8.GetBytes(message.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );

        internal async Task<JsonObject> Read()
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var bytes = new byte[65536];
            var read = await Socket.ReceiveAsync(bytes, limit.Token);
            Assert.Equal(WebSocketMessageType.Text, read.MessageType);
            return JsonNode.Parse(bytes.AsSpan(0, read.Count))!.AsObject();
        }

        internal JsonObject Background(JsonObject request) =>
            new()
            {
                ["type"] = "remote_exec_background",
                ["sessionId"] = request["sessionId"]!.DeepClone(),
                ["execId"] = request["backgroundExecId"]!.DeepClone(),
                ["completionCapability"] = request["completionCapability"]!.DeepClone(),
            };

        internal JsonObject Completion(JsonObject request, string requestId = "completion") =>
            new()
            {
                ["type"] = "session_event",
                ["requestId"] = requestId,
                ["sessionId"] = request["sessionId"]!.DeepClone(),
                ["message"] = "owned remote completion",
                ["eventType"] = "background",
                ["execId"] = request["backgroundExecId"]!.DeepClone(),
                ["completionCapability"] = request["completionCapability"]!.DeepClone(),
                ["eventId"] =
                    "remote-exec-completion:" + request["backgroundExecId"]!.GetValue<string>(),
            };

        internal Task Respond(JsonObject request, JsonNode? result) =>
            Send(
                new JsonObject
                {
                    ["type"] = "tool_call_response",
                    ["callId"] = request["callId"]!.DeepClone(),
                    ["result"] = result,
                }
            );

        internal async Task<JsonObject> StartBackground()
        {
            var execution = Exec();
            var request = await Read();
            Assert.Equal(Owner.Id, request["sessionId"]!.GetValue<string>());
            Assert.Equal("C:\\remote\\cwd", request["sessionCwd"]!.GetValue<string>());
            await Send(Background(request));
            await Respond(
                request,
                new JsonObject
                {
                    ["output"] = "actual background",
                    ["execId"] = request["backgroundExecId"]!.DeepClone(),
                }
            );
            await execution;
            Assert.True(
                Manager.Nodes.ExecClaims.Has(Owner, request["backgroundExecId"]!.GetValue<string>())
            );
            return request;
        }

        internal async Task Restart()
        {
            Socket.Abort();
            Socket.Dispose();
            await App.StopAsync();
            await App.DisposeAsync();
            await Manager.DisposeAsync();
            Manager = new(Data, Work, Options, HostModels.ForTest(Options), authorityStageHook: (id, stage) => WriteStage?.Invoke(id, stage));
            await Manager.LoadAsync();
            Owner = await Manager.RequiredAsync(Owner.Id);
            Owner.Registry.TriggerOverride = _ =>
            {
                Wakes++;
                return Task.CompletedTask;
            };
            await Connect();
        }

        public async ValueTask DisposeAsync()
        {
            Socket?.Abort();
            Socket?.Dispose();
            if (App is not null)
            {
                await App.StopAsync();
                await App.DisposeAsync();
            }
            if (Manager is not null)
                await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Selected_remote_exec_schema_requires_advertisement_and_current_policy(
        bool advertiseExec
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start(advertiseExec: advertiseExec);
        var definitions = fixture.Manager.ModelDefinitions(fixture.Owner);
        Assert.Equal(
            advertiseExec,
            definitions.Any(node => node?["name"]?.GetValue<string>() == "exec")
        );
        var session = Assert.Single(
            definitions.OfType<JsonObject>(),
            node => node["name"]?.GetValue<string>() == "session"
        );
        Assert.NotEqual("peer collision", session["description"]?.GetValue<string>());
        var explicitOverride = new JsonArray(new JsonObject { ["name"] = "exec" });
        Assert.True(
            JsonNode.DeepEquals(
                explicitOverride,
                fixture.Manager.ModelDefinitions(fixture.Owner, explicitOverride)
            )
        );
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n- id: remote-exec\n  action: deny\n  match:\n    tool: {source: node, name: exec}\n    targetNode: remote\n"
        );
        fixture.Manager.Authorization.Invalidate();
        Assert.DoesNotContain(
            fixture.Manager.ModelDefinitions(fixture.Owner),
            node => node?["name"]?.GetValue<string>() == "exec"
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Durable_admission_retry_and_duplicate_ack_use_the_actual_owner_lane(
        bool afterRename
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var request = await fixture.StartBackground();
        var id = request["backgroundExecId"]!.GetValue<string>();
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "master");
        await fixture.Manager.DeclareWaitAsync(
            fixture.Owner,
            new JsonObject
            {
                ["waitExecIds"] = new JsonArray(id),
                ["wakeIfNoActivityAfterSeconds"] = null,
            }
        );
        fixture.WriteStage = (id, stage) =>
        {
            if (id != fixture.Owner.Id || stage != (afterRename
                ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                : AtomicJsonWriteStage.BeforeRename))
                return;
            fixture.WriteStage = null;
            throw new IOException("Owned strict admission write failure.");
        };
        await fixture.Send(fixture.Completion(request));
        Assert.Equal("error", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.True(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, id));
        Assert.Equal(afterRename ? 1 : 0, fixture.Owner.Entry.Snapshot().Queue.Count);
        await fixture.Send(fixture.Completion(request, "retry"));
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.False(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, id));
        await fixture.Send(fixture.Completion(request, "dropped-ack-retry"));
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.Single(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Equal(1, fixture.Wakes);
        var saved = JsonNode.Parse(
            await File.ReadAllTextAsync(fixture.Owner.AuthorityStore.AuthorityPath)
        )!;
        Assert.Contains(
            "remote-exec-completion:" + id,
            SessionWait.Strings(saved["meta"]?["acceptedExternalEventIds"])
        );
        Assert.Null(fixture.Owner.WaitSnapshot());
    }

    [Fact]
    public async Task Registration_requires_the_exact_reserved_identity_not_a_returned_exec_id()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var execution = fixture.Exec();
        var request = await fixture.Read();
        var invalid = fixture.Background(request);
        invalid["execId"] = "invented-id";
        await fixture.Send(invalid);
        Assert.Equal("error", (await fixture.Read())["type"]!.GetValue<string>());
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            fixture.Manager.DeclareWaitAsync(
                fixture.Owner,
                new JsonObject
                {
                    ["waitExecIds"] = new JsonArray(request["backgroundExecId"]!.DeepClone()),
                }
            )
        );
        await fixture.Respond(
            request,
            new JsonObject { ["execId"] = "arbitrary-id", ["output"] = "completed" }
        );
        await execution;
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            fixture.Manager.DeclareWaitAsync(
                fixture.Owner,
                new JsonObject { ["waitExecIds"] = new JsonArray("arbitrary-id") }
            )
        );
        Assert.Null(
            fixture.Manager.Nodes.ExecClaims.Exact(
                "remote",
                fixture.Owner.Id,
                request["backgroundExecId"]!.GetValue<string>(),
                request["completionCapability"]!.GetValue<string>()
            )
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_retains_the_correlation_for_real_reply_and_only_advertised_cancellation(
        bool supported
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start(cancel: supported);
        using var stop = new CancellationTokenSource();
        var execution = fixture.Exec(stop.Token);
        var request = await fixture.Read();
        stop.Cancel();
        if (supported)
            Assert.Equal("tool_call_cancel", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.False(execution.IsCompleted);
        await fixture.Send(fixture.Background(request));
        await fixture.Respond(
            request,
            new JsonObject { ["output"] = "command was already started and was not killed" }
        );
        var result = await execution;
        Assert.Contains("not killed", result!["output"]!.GetValue<string>());
        Assert.Equal(
            !supported,
            result["output"]!.GetValue<string>().Contains("could not end waiting early")
        );
        Assert.True(
            fixture.Manager.Nodes.ExecClaims.Has(
                fixture.Owner,
                request["backgroundExecId"]!.GetValue<string>()
            )
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Only_an_explicit_prestart_rejection_allows_the_rolling_identity_retry(
        bool legacy
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start(legacy: legacy);
        var execution = fixture.Exec();
        var first = await fixture.Read();
        await fixture.Send(
            new JsonObject
            {
                ["type"] = "tool_call_error",
                ["callId"] = first["callId"]!.DeepClone(),
                ["execStarted"] = false,
                ["error"] = new JsonObject
                {
                    ["message"] = legacy ? "Persistent exec ID is invalid." : "collision",
                    ["code"] = legacy ? null : "PERSISTENT_EXEC_ID_COLLISION",
                },
            }
        );
        var next = await fixture.Read();
        Assert.NotEqual(
            first["backgroundExecId"]!.GetValue<string>(),
            next["backgroundExecId"]!.GetValue<string>()
        );
        if (legacy)
            Assert.StartsWith("exec_", next["backgroundExecId"]!.GetValue<string>());
        await fixture.Send(
            new JsonObject
            {
                ["type"] = "tool_call_error",
                ["callId"] = next["callId"]!.DeepClone(),
                ["execStarted"] = true,
                ["error"] = new JsonObject
                {
                    ["message"] = "possible started effect",
                    ["code"] = "PERSISTENT_EXEC_ID_COLLISION",
                },
            }
        );
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => execution);
        var claim = fixture.Manager.Nodes.ExecClaims.Exact(
            "remote",
            fixture.Owner.Id,
            next["backgroundExecId"]!.GetValue<string>(),
            next["completionCapability"]!.GetValue<string>()
        );
        Assert.NotNull(claim);
        Assert.Equal("outcome-unknown", claim.State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_helper_failure_preserves_definite_rejection_versus_unknown_effect(
        bool uncertain
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var execution = fixture.Exec();
        var request = await fixture.Read();
        var log = Path.Combine(fixture.Temp.Path, "owned.log");
        Exception failure = uncertain
            ? new ExecLaunchUncertainException(log)
            : new System.ComponentModel.Win32Exception(80);
        var response = NodeClient.ToolCallFailure(request, failure, false);
        await fixture.Send(response);
        var error = await Assert.ThrowsAnyAsync<InvalidOperationException>(() => execution);
        var claim = fixture.Manager.Nodes.ExecClaims.Exact(
            "remote",
            fixture.Owner.Id,
            request["backgroundExecId"]!.GetValue<string>(),
            request["completionCapability"]!.GetValue<string>()
        );
        if (uncertain)
        {
            Assert.NotNull(claim);
            Assert.Equal("outcome-unknown", claim.State);
            Assert.False(response.ContainsKey("execStarted"));
            Assert.Contains(log, error.Message);
            Assert.Contains(log + ".exit.json", error.Message);
            Assert.Contains(log + ".cwd.txt", error.Message);
        }
        else
        {
            Assert.Null(claim);
            Assert.False(response["execStarted"]!.GetValue<bool>());
        }
    }

    [Fact]
    public async Task Rename_rebinds_the_real_owner_and_delete_fences_the_old_lifetime()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var request = await fixture.StartBackground();
        var old = fixture.Owner.Id;
        await fixture.Manager.MoveIdentityAsync(
            fixture.Owner,
            new JsonObject
            {
                ["newSessionId"] = "renamed",
                ["createAgent"] = true,
                ["newAgentName"] = "moved",
            }
        );
        Assert.Equal("moved/renamed", fixture.Owner.Id);
        Assert.True(
            fixture.Manager.Nodes.ExecClaims.Has(
                fixture.Owner,
                request["backgroundExecId"]!.GetValue<string>()
            )
        );
        await fixture.Send(fixture.Completion(request));
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.Single(fixture.Owner.Entry.Snapshot().Queue);
        await fixture.Owner.Entry.SaveLane.DropCapturedQueueAsync(
            fixture.Owner.Entry.Snapshot().Queue
        );
        Assert.Equal(
            "deleted",
            (await fixture.Manager.DeleteAsync(fixture.Owner.Id))["status"]!.GetValue<string>()
        );
        await fixture.Send(fixture.Completion(request, "late"));
        Assert.Equal("error", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.Null(await fixture.Manager.GetExistingAsync(old));
        Assert.Null(SessionWait.Text(fixture.Manager.Catalog.Resolve(old)["sessionId"]));
    }

    [Fact]
    public async Task Restart_accepts_a_durable_duplicate_but_not_a_new_unproven_completion()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var durable = await fixture.StartBackground();
        await fixture.Send(fixture.Completion(durable));
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        var unproven = await fixture.StartBackground();
        await fixture.Restart();
        Assert.False(
            fixture.Manager.Nodes.ExecClaims.Has(
                fixture.Owner,
                unproven["backgroundExecId"]!.GetValue<string>()
            )
        );
        await fixture.Send(fixture.Completion(durable, "durable-replay"));
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        await fixture.Send(fixture.Completion(unproven, "unproven-replay"));
        Assert.Equal("error", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.Single(
            SessionWait.Strings(fixture.Owner.Entry.Snapshot().Meta["acceptedExternalEventIds"])
        );
    }
}
