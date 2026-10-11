using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal WebApplication App = null!;
        internal HttpClient Client = null!;
        internal JsonObject Credential = null!;
        internal string Connection = "";
        internal int Wakes;
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Auth => Credential["authToken"]!.GetValue<string>();

        internal async Task Start(bool register = true, bool bootstrap = false)
        {
            Manager = new(
                Data,
                Path.Combine(Temp.Path, "work"),
                Options,
                HostModels.ForTest(Options)
            );
            await Manager.LoadAsync();
            Owner = await Manager.CreateNamedAsync("main", "shell-owner", null, null);
            Owner.Registry.TriggerOverride = _ =>
            {
                Wakes++;
                return Task.CompletedTask;
            };
            Credential = Manager.Nodes.Registry.Create("shell");
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            App = builder.Build();
            App.UseWebSockets();
            App.Map("/node_ws", Manager.Nodes.HandleAsync);
            Manager.Nodes.RegisterShellRoutes(App);
            if (bootstrap)
                new NodeBootstrap(
                    Manager.Nodes,
                    new PublicWebAddress("http://127.0.0.1", "", "/", false)
                ).Register(App);
            await App.StartAsync();
            Client = new HttpClient
            {
                BaseAddress = new Uri(App.Urls.Single()),
                Timeout = TimeSpan.FromSeconds(35),
            };
            if (register)
                await Register();
        }

        internal async Task Register()
        {
            using var response = await Request(
                "register",
                Encoding.UTF8.GetBytes("/startup's directory")
            );
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            Connection = response.Headers.GetValues("X-Foxwarm-Connection").Single();
        }

        internal async Task<HttpResponseMessage> Request(
            string endpoint,
            byte[]? bytes = null,
            Dictionary<string, string>? headers = null,
            string? auth = null,
            string? connection = null
        )
        {
            using var request = new HttpRequestMessage(
                endpoint == "poll" ? HttpMethod.Get : HttpMethod.Post,
                "/node/shell/" + endpoint
            );
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", auth ?? Auth);
            request.Headers.Add("X-Foxwarm-Node", "shell");
            request.Headers.Add("X-Foxwarm-Connection", connection ?? Connection);
            if (headers is not null)
                foreach (var pair in headers)
                    request.Headers.Add(pair.Key, pair.Value);
            if (endpoint != "poll")
            {
                request.Content = new ByteArrayContent(bytes ?? []);
                request.Content.Headers.ContentType = new("application/octet-stream");
            }
            return await Client.SendAsync(request);
        }

        internal Task<JsonNode?> Exec(JsonObject? args = null, bool programmatic = false) =>
            Manager.Nodes.ExecuteAsync(
                "shell",
                "exec",
                args ?? new JsonObject { ["command"] = "printf owned-effect" },
                Owner.Id,
                Owner.Agent,
                "shell",
                "relative",
                programmatic,
                default,
                Owner
            );

        internal async Task<(string Task, string Exec, string Script, string Timeout)> Poll()
        {
            using var response = await Request("poll");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("foxwarm-shell-1", response.Headers.GetValues("X-Foxwarm-Shell").Single());
            Assert.Equal(
                "application/x-foxwarm-shell; charset=utf-8",
                response.Content.Headers.ContentType!.ToString()
            );
            return (
                response.Headers.GetValues("X-Foxwarm-Task").Single(),
                response.Headers.GetValues("X-Foxwarm-Exec").Single(),
                await response.Content.ReadAsStringAsync(),
                response.Headers.GetValues("X-Foxwarm-Timeout").Single()
            );
        }

        internal Task<HttpResponseMessage> Report(
            string task,
            bool finished = false,
            byte[]? sample = null,
            string? connection = null,
            string? total = null,
            string exit = "0"
        ) =>
            Request(
                "report",
                sample,
                new()
                {
                    ["X-Foxwarm-Task"] = task,
                    ["X-Foxwarm-Result"] = finished ? "finished" : "background",
                    ["X-Foxwarm-Bytes"] = total ?? (sample?.Length ?? 0).ToString(),
                    ["X-Foxwarm-Exit"] = exit,
                    // Untrusted client fields do not route or create authority.
                    ["X-Foxwarm-Session"] = "not-the-owner",
                    ["X-Foxwarm-Completion-Capability"] = "invented",
                },
                connection: connection
            );

        public async ValueTask DisposeAsync()
        {
            Client?.Dispose();
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
    public async Task Background_reports_serialize_and_ack_only_after_existing_strict_admission(
        bool afterRename
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "shell");
        var execution = fixture.Exec();
        var task = await fixture.Poll();
        Assert.Equal(
            "cd '/startup'\"'\"'s directory/relative' || exit 125\nprintf owned-effect\n",
            task.Script
        );
        // A client report cannot claim an undelivered task or wrong connection.
        Assert.Equal(
            HttpStatusCode.Gone,
            (await fixture.Report(task.Task, connection: new string('a', 32))).StatusCode
        );
        var starts = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(_ => fixture.Report(task.Task))
        );
        foreach (var response in starts)
        {
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            response.Dispose();
        }
        Assert.Equal(task.Exec, (await execution)!["execId"]!.GetValue<string>());
        Assert.True(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "master");
        await fixture.Manager.DeclareWaitAsync(
            fixture.Owner,
            new JsonObject
            {
                ["waitExecIds"] = new JsonArray(task.Exec),
                ["wakeIfNoActivityAfterSeconds"] = null,
            }
        );
        var faults = Path.Combine(fixture.Data, "state", "experiment-faults");
        Directory.CreateDirectory(faults);
        await File.WriteAllTextAsync(
            Path.Combine(
                faults,
                SessionIdentity.ExecDirectorySegment(fixture.Owner.Id)
                    + (afterRename ? ".wait-after-rename" : ".wait-before-rename")
            ),
            "fault"
        );
        using var rejected = await fixture.Report(
            task.Task,
            true,
            Encoding.UTF8.GetBytes("actual completion")
        );
        Assert.Equal(HttpStatusCode.ServiceUnavailable, rejected.StatusCode);
        Assert.False(rejected.Headers.Contains("X-Foxwarm-Shell"));
        Assert.True(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
        Assert.Equal(afterRename ? 1 : 0, fixture.Owner.Entry.Snapshot().Queue.Count);
        var completed = await Task.WhenAll(
            Enumerable
                .Range(0, 6)
                .Select(_ =>
                    fixture.Report(task.Task, true, Encoding.UTF8.GetBytes("actual completion"))
                )
        );
        foreach (var response in completed)
        {
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            response.Dispose();
        }
        Assert.False(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
        Assert.Single(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Null(fixture.Owner.WaitSnapshot());
        Assert.Equal(1, fixture.Wakes);
        var document = JsonNode.Parse(
            await File.ReadAllTextAsync(fixture.Owner.AuthorityStore.AuthorityPath)
        )!;
        Assert.Single(SessionWait.Strings(document["meta"]?["acceptedExternalEventIds"]));
        Assert.Contains(
            "actual completion",
            fixture.Owner.Entry.Snapshot().Queue.Single().Parts!.Single().ToJsonString()
        );
        using var lateBackground = await fixture.Report(task.Task);
        Assert.Equal(HttpStatusCode.NoContent, lateBackground.StatusCode);
        Assert.False(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
    }

    [Fact]
    public async Task Unfinished_bound_and_queued_disconnect_release_without_handoff_or_replay()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var executions = Enumerable.Range(0, 32).Select(_ => fixture.Exec()).ToArray();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Exec());
        var old = fixture.Connection;
        await fixture.Register();
        foreach (var execution in executions)
            await Assert.ThrowsAsync<IOException>(() => execution);
        var fields = typeof(NodeConnectionHub).GetField(
            "shellTasks",
            BindingFlags.NonPublic | BindingFlags.Instance
        )!;
        Assert.Empty(
            ((System.Collections.IDictionary)fields.GetValue(fixture.Manager.Nodes)!).Keys
        );
        // A fresh effect can use the successor; nothing from the predecessor is handed out.
        var fresh = fixture.Exec(new JsonObject { ["command"] = "printf new" });
        var task = await fixture.Poll();
        Assert.Contains("printf new", task.Script);
        using var report = await fixture.Report(task.Task, true, Encoding.UTF8.GetBytes("new"));
        Assert.Equal(HttpStatusCode.NoContent, report.StatusCode);
        Assert.Equal(3, (await fresh)!["totalBytes"]!.GetValue<long>());
        using var stale = await fixture.Request("poll", connection: old);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
    }

    [Fact]
    public async Task Finished_transport_receipts_are_bounded_separately_from_durable_owner_receipts()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        string first = "";
        for (var index = 0; index < 34; index++)
        {
            var execution = fixture.Exec();
            var task = await fixture.Poll();
            if (index == 0)
                first = task.Task;
            using var report = await fixture.Report(task.Task, true);
            Assert.Equal(HttpStatusCode.NoContent, report.StatusCode);
            await execution;
        }
        var fields = typeof(NodeConnectionHub).GetField(
            "shellTasks",
            BindingFlags.NonPublic | BindingFlags.Instance
        )!;
        Assert.Equal(
            32,
            ((System.Collections.IDictionary)fields.GetValue(fixture.Manager.Nodes)!).Count
        );
        using var expired = await fixture.Report(first, true);
        Assert.Equal(HttpStatusCode.Gone, expired.StatusCode);
        Assert.Empty(
            SessionWait.Strings(fixture.Owner.Entry.Snapshot().Meta["acceptedExternalEventIds"])
        );
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Octet_stream_body_and_metadata_bounds_do_not_settle_invalid_foreground_results()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        using var largeCwd = await fixture.Request(
            "register",
            Encoding.UTF8.GetBytes("/" + new string('x', 4096))
        );
        Assert.Equal(HttpStatusCode.BadRequest, largeCwd.StatusCode);
        using var newlineCwd = await fixture.Request("register", Encoding.UTF8.GetBytes("/cwd\n"));
        Assert.Equal(HttpStatusCode.BadRequest, newlineCwd.StatusCode);
        var execution = fixture.Exec(programmatic: true);
        var task = await fixture.Poll();
        using var large = await fixture.Report(task.Task, true, new byte[8193]);
        Assert.Equal(HttpStatusCode.BadRequest, large.StatusCode);
        foreach (var total in new[] { "2", "-1", "9007199254740992", "1.1" })
        {
            using var response = await fixture.Report(task.Task, true, [65], total: total);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
        using var invalidExit = await fixture.Report(task.Task, true, [65], exit: "256");
        Assert.Equal(HttpStatusCode.BadRequest, invalidExit.StatusCode);
        Assert.False(execution.IsCompleted);
        using var binary = await fixture.Report(task.Task, true, [0, 255]);
        Assert.Equal(HttpStatusCode.NoContent, binary.StatusCode);
        var result = (await execution)!;
        Assert.True(result["truncated"]!.GetValue<bool>());
        Assert.Null(result["content"]);
        Assert.Contains("00ff", result["output"]!.GetValue<string>());
        using var missing = await fixture.Request(
            "report",
            [],
            new() { ["X-Foxwarm-Task"] = new string('b', 32) }
        );
        Assert.Equal(HttpStatusCode.Gone, missing.StatusCode);
        var node = Assert.Single(fixture.Manager.Nodes.List().OfType<JsonObject>());
        Assert.Single(node["tools"]!.AsArray());
        Assert.Empty(node["services"]!.AsObject());
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            fixture.Manager.Nodes.ReadFileAsync(
                "shell",
                "/cannot-fall-back",
                fixture.Owner,
                false,
                default
            )
        );
        var service = Assert.Throws<Foxwarm.Code.CodeServiceException>(() =>
            fixture.Manager.Nodes.Service("shell", "vscode-pty")
        );
        Assert.Equal("UnsupportedService", service.Code);
        using var json = new HttpRequestMessage(HttpMethod.Post, "/node/shell/register")
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        };
        json.Headers.Authorization = new("Bearer", fixture.Auth);
        json.Headers.Add("X-Foxwarm-Node", "shell");
        using var wrongType = await fixture.Client.SendAsync(json);
        Assert.Equal(HttpStatusCode.BadRequest, wrongType.StatusCode);
    }
}
