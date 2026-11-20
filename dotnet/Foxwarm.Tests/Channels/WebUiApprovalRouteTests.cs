using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiApprovalRouteTests
{
    [Fact]
    public async Task Approval_routes_let_the_administrator_and_named_scoped_approvers_decide_once()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            "vector: false\ndbWorkers: false\naccess:\n  identities:\n"
                + "    approver:\n      token: synthetic-approval-approver\n      surfaces:\n        webui: {sessions: [gated]}\n"
                + "    bystander:\n      token: synthetic-approval-bystander\n      surfaces:\n        webui: {sessions: [gated]}\n"
                + "    outsider:\n      token: synthetic-approval-outsider\n      surfaces:\n        webui: {sessions: [elsewhere]}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "synthetic",
            "",
            713
        );
        await using var manager = new SessionManager(data, work, options, configuration.Models);
        await manager.LoadMainHostAsync();
        var gated = await manager.CreateNamedAsync("main", "gated", null, null);
        var elsewhere = await manager.CreateNamedAsync("main", "elsewhere", null, null);
        gated.Registry.TriggerOverride = _ => Task.CompletedTask;
        elsewhere.Registry.TriggerOverride = _ => Task.CompletedTask;

        // Pending records as the dispatch gate writes them: the second one's arguments were
        // too large to store, so only its live waiter holds them.
        var full = new JsonObject { ["command"] = new string('x', 20_000) };
        async Task<Task<JsonObject>> Pending(
            string id,
            string[] approvers,
            JsonObject args,
            bool truncated
        )
        {
            var waiter = gated.ApprovalWaiters.Register(id, args);
            var record = new JsonObject
            {
                ["id"] = id,
                ["status"] = "pending",
                ["createdAt"] = 1,
                ["origin"] = "turn",
                ["tool"] = new JsonObject { ["source"] = "node", ["name"] = "exec" },
                ["summary"] = "exec",
                ["rules"] = new JsonArray(new JsonObject { ["layer"] = "global", ["id"] = "r" }),
                ["approvers"] = new JsonArray(
                    approvers.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                ),
            };
            if (truncated)
            {
                record["argsPreview"] = "{\"command\":\"xxx";
                record["argsTruncated"] = true;
            }
            else
                record["args"] = args.DeepClone();
            await gated.Entry.SaveLane.MutateQuestionsAsync(meta =>
            {
                SessionApprovals.Add(meta, record);
                return id;
            });
            return waiter.Decision.Task;
        }
        var named = await Pending(
            "ap-named0001",
            ["approver", "outsider"],
            new JsonObject { ["command"] = "ls" },
            false
        );
        var large = await Pending("ap-large0001", ["approver"], full, true);
        var adminOnly = await Pending(
            "ap-admin0001",
            [],
            new JsonObject { ["command"] = "id" },
            false
        );

        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
        var runtime = new SessionRuntime(manager);
        var server = new HttpServer(
            [],
            0,
            "synthetic-approval-admin",
            null,
            manager,
            terminals,
            webUiEnabled: true
        );
        new WebUIChannel(
            manager,
            runtime,
            new MessageRouter(runtime),
            terminals,
            server.Downloads
        ).Register(server.App);
        await server.App.StartAsync();
        try
        {
            HttpClient Client(string token)
            {
                var client = new HttpClient(new HttpClientHandler { UseCookies = false })
                {
                    BaseAddress = new Uri(server.App.Urls.Single() + "/"),
                };
                client.DefaultRequestHeaders.Authorization = new("Bearer", token);
                return client;
            }
            using var admin = Client("synthetic-approval-admin");
            using var approver = Client("synthetic-approval-approver");
            using var bystander = Client("synthetic-approval-bystander");
            using var outsider = Client("synthetic-approval-outsider");
            static async Task<JsonObject> Json(HttpResponseMessage response) =>
                (JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject)!;
            Task<HttpResponseMessage> Decide(
                HttpClient client,
                string id,
                string decision,
                string? note = null
            )
            {
                var body = new JsonObject { ["decision"] = decision };
                if (note is not null)
                    body["note"] = note;
                return client.PostAsJsonAsync($"api/sessions/{gated.Id}/approvals/{id}", body);
            }
            string Status(string id) =>
                gated.Entry.WithState(state =>
                    SessionApprovals.Status(SessionApprovals.Find(state.Meta, id)!)
                );

            async Task<JsonObject> Listed()
            {
                var page = JsonNode.Parse(await admin.GetStringAsync("api/sessions"));
                var rows = page as JsonArray ?? page!["sessions"]!.AsArray();
                return rows.OfType<JsonObject>()
                    .Single(item => SessionWait.Text(item["id"]) == gated.Id);
            }

            // The Session projection counts pending approvals as open requests it waits on.
            var listed = await Listed();
            Assert.Equal(3, listed["questions"]!["open"]!.GetValue<long>());
            Assert.Equal(3, listed["questions"]!["approvals"]!.GetValue<long>());
            Assert.True(listed["questions"]!["waiting"]!.GetValue<bool>());
            var row = manager.Catalog.Get(gated.Id)!;
            Assert.Equal(3, SessionCatalog.Number(row["meta"]!["questions"]!["approvals"]));

            // Each requester learns which pending records it may decide.
            async Task<Dictionary<string, bool>> Decidable(HttpClient client)
            {
                var view = await Json(await client.GetAsync($"api/sessions/{gated.Id}/questions"));
                return view["approvals"]!
                    .AsArray()
                    .ToDictionary(
                        record => SessionWait.Text(record!["id"])!,
                        record => record!["canDecide"]!.GetValue<bool>()
                    );
            }
            Assert.All((await Decidable(admin)).Values, Assert.True);
            var approverView = await Decidable(approver);
            Assert.True(approverView["ap-named0001"]);
            Assert.True(approverView["ap-large0001"]);
            Assert.False(approverView["ap-admin0001"]);
            Assert.All((await Decidable(bystander)).Values, Assert.False);

            // Full arguments come from the live waiter when the record holds only a preview.
            var detail = await approver.GetAsync($"api/sessions/{gated.Id}/approvals/ap-large0001");
            Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
            Assert.True(JsonNode.DeepEquals(full, (await Json(detail))["args"]));
            var hidden = await bystander.GetAsync(
                $"api/sessions/{gated.Id}/approvals/ap-large0001"
            );
            Assert.Equal(HttpStatusCode.Forbidden, hidden.StatusCode);
            Assert.Equal("APPROVAL_NOT_ALLOWED", SessionWait.Text((await Json(hidden))["code"]));

            // Being named is not enough without scope for the Session, and a scoped identity
            // that is not named cannot decide.
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await Decide(outsider, "ap-named0001", "approve")).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await Decide(bystander, "ap-named0001", "approve")).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await Decide(approver, "ap-admin0001", "approve")).StatusCode
            );
            Assert.Equal("pending", Status("ap-named0001"));
            Assert.Equal("pending", Status("ap-admin0001"));

            foreach (
                var body in new[]
                {
                    """{"decision":"maybe"}""",
                    """{"decision":"approve","extra":1}""",
                    """{"decision":"approve","note":5}""",
                    "[]",
                    "{",
                }
            )
            {
                var invalid = await admin.PostAsync(
                    $"api/sessions/{gated.Id}/approvals/ap-named0001",
                    new StringContent(body, System.Text.Encoding.UTF8, "application/json")
                );
                Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            }
            Assert.Equal(
                HttpStatusCode.NotFound,
                (await Decide(admin, "ap-missing01", "approve")).StatusCode
            );

            // A named approver decides; the waiting call receives the committed record.
            var approved = await Decide(approver, "ap-named0001", "approve", "  only this once ");
            Assert.Equal(HttpStatusCode.Accepted, approved.StatusCode);
            Assert.Equal("approved", SessionWait.Text((await Json(approved))["status"]));
            var settled = await named.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal("approved", SessionApprovals.Status(settled));
            Assert.Equal("only this once", SessionWait.Text(settled["note"]));
            Assert.Equal("identity", SessionWait.Text(settled["decidedBy"]!["kind"]));
            Assert.Equal("approver", SessionWait.Text(settled["decidedBy"]!["id"]));

            // The first decision wins.
            var again = await Decide(admin, "ap-named0001", "reject");
            Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
            Assert.Equal("APPROVAL_NOT_PENDING", SessionWait.Text((await Json(again))["code"]));

            var rejected = await Decide(admin, "ap-admin0001", "reject", "not now");
            Assert.Equal(HttpStatusCode.Accepted, rejected.StatusCode);
            var adminRecord = await adminOnly.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal("rejected", SessionApprovals.Status(adminRecord));
            Assert.Equal("administrator", SessionWait.Text(adminRecord["decidedBy"]!["kind"]));
            Assert.False(large.IsCompleted);

            listed = await Listed();
            Assert.Equal(1, listed["questions"]!["approvals"]!.GetValue<long>());
        }
        finally
        {
            await server.App.StopAsync();
        }
    }
}
