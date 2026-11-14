using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    private static ExternalChannelContext Source(
        List<string> replies,
        string conversation = "commands",
        string sender = "11"
    ) =>
        new(
            "alpha",
            "telegram",
            conversation,
            sender,
            "operator",
            text =>
            {
                replies.Add(text);
                return Task.CompletedTask;
            }
        );

    private static ExternalChannelMessage Message(string text) =>
        new([new JsonObject { ["text"] = text }]);

    internal static async Task<JsonObject> SourceAsync(JsonObject input)
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required");
        var start = new ProcessStartInfo(
            "node",
            Path.Combine(
                root,
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "command-administration-fixture-ts.mjs"
            )
        )
        {
            WorkingDirectory = root,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(input.ToJsonString());
        process.StandardInput.Close();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True(process.ExitCode == 0, await stderr);
        return JsonNode.Parse(await stdout)!.AsObject();
    }

    [Fact]
    public async Task Generated_catalog_projects_registry_heads_autocomplete_and_completed_effects()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        await f.Router.HandleExternalMessageAsync(source, Message("/help"));
        var help = replies.Single();
        var telegram = UserCommands
            .TelegramCommands()
            .OfType<JsonObject>()
            .Select(row => "/" + row["command"])
            .ToArray();
        var web = UserCommands.WebUiCommands().OfType<JsonObject>().ToArray();
        // Heads: help, the shortcuts and every noun with a user command, in every projection.
        Assert.Equal(
            UserCommands.Heads.Order(StringComparer.Ordinal),
            web.Select(row => row["name"]!.GetValue<string>())
        );
        Assert.Equal(web.Select(row => row["name"]!.GetValue<string>()), telegram);
        Assert.All(telegram, name => Assert.Matches("^/[a-z0-9_]{1,32}$", name));
        foreach (var head in new[] { "/session", "/history", "/agent", "/skill", "/timer", "/node", "/channel", "/stop", "/compact", "/whoami" })
        {
            Assert.Contains(head, UserCommands.Heads);
            Assert.Contains("`" + head + "`", help);
        }
        // Retired heads and model-only nouns are not commands.
        foreach (var name in new[] { "/messages", "/delete-messages", "/verbose", "/search", "/attach", "/memory", "/file", "/tool", "/tools", "/config", "/index", "/retry" })
            Assert.Null(UserCommands.Find(name));
        Assert.True(UserCommands.Find("/stop")!["requiresSession"]!.GetValue<bool>());
        Assert.All(
            web,
            row =>
            {
                Assert.NotNull(row["description"]);
                Assert.NotNull(row["requiresSession"]);
                Assert.NotNull(row["showInTelegram"]);
                Assert.True(row.ContainsKey("usage"));
            }
        );
        Assert.Contains(
            UserCommands.Find("/compact")!["autocomplete"]!["children"]!.AsArray(),
            row => SessionWait.Text(row?["value"]) == "--tools"
        );
        var session = UserCommands.Find("/session")!["autocomplete"]!["children"]!.AsArray();
        Assert.Contains(session, row => SessionWait.Text(row?["value"]) == "messages");
        Assert.DoesNotContain(session, row => SessionWait.Text(row?["value"]) == "view");
        var verbose = session.Single(row => SessionWait.Text(row?["value"]) == "verbose")!;
        Assert.Contains(verbose["children"]!.AsArray(), row => SessionWait.Text(row?["value"]) == "on");
        Assert.Contains(
            UserCommands.Find("/agent")!["autocomplete"]!["children"]!.AsArray(),
            row => SessionWait.Text(row?["value"]) == "delete"
        );
        f.Manager.AttachChannel(source.Target, f.Owner);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/session messages -1"));
        Assert.Contains("No messages", replies.Single());
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Explicit_target_Session_catalog_administration_works_without_binding_and_does_not_admit_cold_owners()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        var other = await f.Manager.CreateNamedAsync("main", "target", null, null);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session set-parent " + f.Owner.Id + " --session-id " + other.Id)
        );
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.Catalog.Get(other.Id)?["parentSessionId"])
        );
        await f.Router.HandleExternalMessageAsync(source, Message("/session archive " + other.Id));
        Assert.True(SessionCatalog.Flag(f.Manager.Catalog.Get(other.Id)?["archived"]));
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session unarchive " + other.Id)
        );
        await f.Router.HandleExternalMessageAsync(source, Message("/session clear-parent --session-id " + other.Id));
        Assert.Null(f.Manager.Catalog.Get(other.Id)?["parentSessionId"]);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session refresh-snapshot " + other.Id)
        );
        Assert.Contains(replies, reply => reply.Contains("snapshot refreshed"));
        Assert.Null(f.Manager.ChannelBinding(source.Target));
        var lookup = new List<string>();
        var runtime = new SessionRuntime(f.Manager) { SemanticOwnerLookupObserved = lookup.Add };
        var router = new MessageRouter(runtime);
        replies.Clear();
        await router.HandleExternalMessageAsync(source, Message("/session list"));
        Assert.Contains(other.Id, replies.Single());
        Assert.Empty(lookup);
        replies.Clear();
        await router.HandleExternalMessageAsync(source, Message("/session delete " + other.Id));
        Assert.Null(f.Manager.Catalog.Get(other.Id));
        Assert.Contains("deleted", replies.Single());
    }

    [Fact]
    public async Task Actual_router_and_Telegram_direct_entries_preserve_override_only_and_unauthorized_distinctions()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var unauthorized = Source(replies, sender: "999");
        await f.Router.HandleExternalMessageAsync(
            unauthorized,
            Message("/agent create forbidden --no-create-main-session")
        );
        Assert.DoesNotContain("forbidden", f.Manager.Agents());
        Assert.Contains("Unauthorized", replies.Single());
        f.Manager.AttachChannel(unauthorized.Target, f.Owner);
        f.Manager.SetChannelBinding(
            unauthorized.Target,
            "dangerouslyAllowAllUsers",
            JsonValue.Create(true)
        );
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(
            unauthorized,
            Message("/agent create ordinary --no-create-main-session")
        );
        Assert.DoesNotContain("ordinary", f.Manager.Agents());
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Empty(replies);
        await f.Router.HandleExternalCommandAsync(
            unauthorized,
            "/agent",
            "create direct --no-create-main-session"
        );
        Assert.Contains("direct", f.Manager.Agents());
        Assert.Contains("created successfully", replies.Single());
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding(unauthorized.Target)?["sessionId"])
        );
    }

    [Fact]
    public async Task Source_model_selection_uses_hidden_exact_keys_but_only_displayed_keys_for_partial_matching()
    {
        string[] selections =
        [
            "wire",
            "local/wire",
            "local/WI",
            "virt",
            "local/",
            "local",
            "second/wire",
            "missing",
        ];
        var source = await SourceAsync(
            new JsonObject
            {
                ["operation"] = "parsers",
                ["displayModels"] = new JsonArray("local", "second", "virtual"),
                ["selections"] = System.Text.Json.JsonSerializer.SerializeToNode(selections),
                ["create"] = new JsonArray(),
                ["efforts"] = new JsonArray(),
                ["thresholds"] = new JsonArray(),
                ["moves"] = new JsonArray(),
                ["timers"] = new JsonArray(),
            }
        );
        var models = HostModels.Parse(
            ConfigurationYaml.Parse(
                """
                default: local/wire
                providers:
                  local:
                    providerType: openai-responses
                    baseUrl: http://127.0.0.1:1/v1
                    models: [wire]
                  second:
                    providerType: openai-responses
                    baseUrl: http://127.0.0.1:1/v1
                    models: [wire]
                  virtual:
                    providerType: failover
                    targets: [local/wire, second/wire]
                """,
                "synthetic models"
            ),
            new JsonObject()
        );
        for (var index = 0; index < selections.Length; index++)
        {
            var expected = source["selections"]![index]!;
            string? actual = null;
            var error = Record.Exception(() =>
                actual = CommandArguments.ResolveModel(selections[index], models)
            );
            Assert.True(
                (expected["error"] is not null) == (error is not null),
                selections[index] + " Source=" + expected + " C#=" + (error?.Message ?? actual)
            );
            if (error is null)
                Assert.Equal(SessionWait.Text(expected["key"]), actual);
        }
    }
}
