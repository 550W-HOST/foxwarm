using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Fact]
    public async Task Normal_Main_administrator_selected_target_scoped_refusal_catalog_and_restart_use_real_HTTP_owners()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            """
            access:
              identities:
                reader:
                  token: synthetic-command-reader
                  surfaces:
                    webui: {sessions: [selected]}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1/v1
                models: [wire]
            """
        );
        string? selectedId = null;
        for (var phase = 0; phase < 2; phase++)
        {
            var configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
            );
            var settings = await HttpServerSettings.CaptureDesktopAsync(data);
            await using var host = await MainHost.CreateAsync([], configuration, settings);
            await host.StartAsync();
            using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
            admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
            using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
            scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-command-reader");
            using var stranger = new HttpClient { BaseAddress = admin.BaseAddress };
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await stranger.GetAsync("api/commands")).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await scoped.GetAsync("api/commands")).StatusCode
            );
            Directory.CreateDirectory(Path.Combine(data, "agents", "directory-only"));
            var commands = (await admin.GetFromJsonAsync<JsonObject>("api/commands"))![
                "commands"
            ]!.AsArray();
            Assert.Contains(
                commands,
                row =>
                    SessionWait.Text(row?["name"]) == "/messages"
                    && row?["showInTelegram"]?.GetValue<bool>() == false
            );
            Assert.Contains(
                commands,
                row =>
                    SessionWait.Text(row?["name"]) == "/session"
                    && row?["autocomplete"] is JsonObject
            );
            HttpResponseMessage? eventStream = null;
            Task<string>? eventBody = null;
            if (phase == 0)
            {
                foreach (var name in new[] { "other", "selected" })
                {
                    var created = await admin.PostAsync(
                        "api/sessions",
                        new StringContent(
                            new JsonObject
                            {
                                ["agentId"] = "main",
                                ["sessionId"] = name,
                            }.ToJsonString(),
                            System.Text.Encoding.UTF8,
                            "application/json"
                        )
                    );
                    Assert.True(
                        created.IsSuccessStatusCode,
                        await created.Content.ReadAsStringAsync()
                    );
                    if (name == "selected")
                        selectedId = SessionWait.Text(
                            (await created.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]
                        );
                }
                eventStream = await admin.GetAsync(
                    "api/sessions/" + Uri.EscapeDataString(selectedId!) + "/stream",
                    HttpCompletionOption.ResponseHeadersRead
                );
                eventStream.EnsureSuccessStatusCode();
                eventBody = eventStream.Content.ReadAsStringAsync();
                var route = "api/sessions/" + Uri.EscapeDataString(selectedId!) + "/message";
                var denied = await scoped.PostAsJsonAsync(
                    route,
                    new { text = "/model --effort none" }
                );
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
                denied = await scoped.PostAsJsonAsync(
                    route,
                    new { text = "ordinary", parts = new[] { new { text = "/agent list" } } }
                );
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
                foreach (
                    var text in new[]
                    {
                        "/model --effort none",
                        "/session compact-threshold 9.5k",
                        "/session rename Selected owner",
                        "/timer after 3600 persisted timer",
                        "/status",
                        "/messages -1",
                        "/agent list",
                    }
                )
                {
                    var response = await admin.PostAsJsonAsync(route, new { text });
                    Assert.True(
                        response.IsSuccessStatusCode,
                        await response.Content.ReadAsStringAsync()
                    );
                }
                foreach (
                    var text in new[]
                    {
                        "/session compact-threshold 0.9",
                        "/session compact-threshold",
                    }
                )
                {
                    var response = await admin.PostAsJsonAsync(
                        route,
                        new { parts = new[] { new { text } } }
                    );
                    Assert.True(
                        response.IsSuccessStatusCode,
                        await response.Content.ReadAsStringAsync()
                    );
                }
                foreach (
                    var text in new[]
                    {
                        "/stop",
                        "/dequeue",
                        "/continue",
                        "/compact 20",
                        "/compact tools 50",
                    }
                )
                {
                    var response = await admin.PostAsJsonAsync(
                        route,
                        new { text, controlRequestId = "correlated-" + text }
                    );
                    Assert.True(
                        response.IsSuccessStatusCode,
                        text + ": " + await response.Content.ReadAsStringAsync()
                    );
                }
            }
            var history = (
                await admin.GetFromJsonAsync<JsonObject>(
                    "api/sessions/" + Uri.EscapeDataString(selectedId!) + "/history"
                )
            )!;
            Assert.Empty(history["messages"]!.AsArray());
            Assert.Equal("none", SessionWait.Text(history["session"]?["effort"]));
            Assert.Equal(9500, SessionWait.Number(history["session"]?["compactThresholdTokens"]));
            var listed = (await admin.GetFromJsonAsync<JsonObject>("api/sessions"))!;
            Assert.Contains("Selected owner", listed.ToJsonString());
            var otherResponse = await admin.GetAsync(
                "api/sessions/" + Uri.EscapeDataString("other") + "/history"
            );
            Assert.True(
                otherResponse.IsSuccessStatusCode,
                $"phase={phase}: {await otherResponse.Content.ReadAsStringAsync()}"
            );
            var otherHistory = (await otherResponse.Content.ReadFromJsonAsync<JsonObject>())!;
            Assert.Null(otherHistory["session"]?["effort"]);
            Assert.Null(otherHistory["session"]?["compactThresholdTokens"]);
            var timers = JsonNode.Parse(
                await File.ReadAllTextAsync(Path.Combine(data, "state", "timers.json"))
            )!;
            Assert.Contains(
                timers["timers"]!.AsArray(),
                row =>
                    SessionWait.Text(row?["sessionId"]) == selectedId
                    && SessionWait.Text(row?["message"]) == "persisted timer"
            );
            await host.DisposeAsync();
            if (eventBody is not null)
            {
                var events = await eventBody.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.Contains("directory-only", events);
                Assert.Contains("9500", events);
                Assert.Contains(
                    "compactThresholdTokens must be a positive number or null.",
                    events
                );
                Assert.Contains(selectedId!, events);
                Assert.Contains("session-control-feedback", events);
                eventStream!.Dispose();
            }
        }
    }

    [Fact]
    public async Task Correlated_controls_keep_one_feedback_no_history_and_empty_tools_pruning_does_not_run_model_compaction()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var events = new List<SessionRuntimeEvent>();
        f.Manager.Changed += events.Add;
        foreach (
            var text in new[]
            {
                "/stop",
                "/dequeue",
                "/compact 20",
                "/compact invalid",
                "/compact tools 50",
            }
        )
        {
            events.Clear();
            await f.Router.HandleMessageAsync(
                new(f.Owner.Id, "webui"),
                new(text, null, ControlRequestId: "request")
            );
            var feedback = Assert.Single(
                events,
                e => SessionWait.Text(e.Data?["type"]) == "session-control-feedback"
            );
            Assert.Equal("request", SessionWait.Text(feedback.Data?["requestId"]));
            Assert.Equal("noop", SessionWait.Text(feedback.Data?["feedback"]?["status"]));
            Assert.DoesNotContain(events, e => e.Kind == SessionEventKind.CommandReply);
            Assert.Empty(f.Owner.History());
        }
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/stop"));
        Assert.DoesNotContain("{", replies.Single());
        Assert.Empty(f.Owner.History());
    }

    [Fact]
    public async Task Omitted_session_fork_suffix_uses_owner_default_and_numbered_collisions_through_generic_and_selected_entries()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        for (var number = 1; number <= 2; number++)
        {
            f.Manager.DetachChannel(source.Target);
            f.Manager.AttachChannel(source.Target, f.Owner);
            replies.Clear();
            await f.Router.HandleExternalMessageAsync(source, Message("/session fork"));
            var expected = f.Owner.Id + "_fork" + (number == 1 ? "" : "_" + number);
            Assert.Equal(
                expected,
                SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
            );
            Assert.NotNull(f.Manager.Catalog.Get(expected));
            Assert.Contains(expected, replies.Single());
        }
        var events = new List<SessionRuntimeEvent>();
        f.Manager.Changed += events.Add;
        for (var number = 3; number <= 4; number++)
        {
            events.Clear();
            await f.Router.HandleMessageAsync(new(f.Owner.Id, "webui"), new("/session fork", null));
            var expected = f.Owner.Id + "_fork_" + number;
            Assert.Equal(
                expected,
                SessionWait.Text(f.Manager.ChannelBinding("webui:" + f.Owner.Id)?["sessionId"])
            );
            Assert.NotNull(f.Manager.Catalog.Get(expected));
            Assert.Single(events, e => e.Kind == SessionEventKind.CommandReply);
        }
        f.Manager.DetachChannel(source.Target);
        f.Manager.AttachChannel(source.Target, f.Owner);
        Assert.Empty(f.Owner.History());
        var before = f
            .Manager.Catalog.List()
            .Select(row => SessionWait.Text(row["id"]))
            .ToHashSet();
        await f.Router.HandleExternalMessageAsync(source, Message("/fork"));
        var generated = f
            .Manager.Catalog.List()
            .Single(row => !before.Contains(SessionWait.Text(row["id"])));
        Assert.Matches(
            "^" + System.Text.RegularExpressions.Regex.Escape(f.Owner.Id) + @"_\d{4}_[a-z0-9]{5}$",
            SessionWait.Text(generated["id"])!
        );
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }

    [Fact]
    public async Task Raw_multiline_fork_matches_Source_keeps_parent_attachment_and_session_fork_rebinds()
    {
        const string raw = "leaf First line\n\n  second line  ";
        var expected = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/fork",
                ["args"] = new JsonArray("leaf", "First", "line", "second", "line"),
                ["raw"] = raw,
                ["binding"] = "main/source",
            }
        );
        Assert.Equal(
            "First line\n\n  second line  ",
            SessionWait.Text(
                expected["effects"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Single(row => SessionWait.Text(row["action"]) == "enqueue")["item"]
                    ?["parts"]?[0]?["text"]
            )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/fork " + raw));
        Assert.True(
            f.Manager.Catalog.Get(f.Owner.Id + "_leaf") is not null,
            string.Join("\n", replies)
        );
        var child = await f.Manager.RequiredAsync(f.Owner.Id + "_leaf");
        Assert.Equal(
            "First line\n\n  second line  ",
            SessionWait.Text(child.Entry.Snapshot().Queue.Single().Parts?[0]?["text"])
        );
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        Assert.Contains("Initial message sent", replies.Single());
        var count = f.Manager.Catalog.List().Length;
        await f.Router.HandleExternalMessageAsync(source, Message("/fork " + raw));
        Assert.Equal(count, f.Manager.Catalog.List().Length);
        await f.Router.HandleExternalMessageAsync(source, Message("/session fork sibling"));
        Assert.Equal(
            f.Owner.Id + "_sibling",
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }
}
