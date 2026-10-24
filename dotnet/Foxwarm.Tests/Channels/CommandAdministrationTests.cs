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
    public async Task Frozen_Source_create_and_effort_parsers_match_supported_success_and_rejection_cases()
    {
        string[][] creates =
        [
            [],
            [
                "--model",
                "virtual",
                "--effort",
                "NONE",
                "--system-prompt-file",
                "a",
                "--system-prompt-file",
                "b",
            ],
            ["--model"],
            ["--model", "--effort", "high"],
            ["--effort", "default"],
            ["--model", "a", "--model", "b"],
            ["--effort", "low", "--effort", "high"],
            ["extra"],
        ];
        string[][] efforts =
        [
            [],
            ["--effort", "none"],
            ["wire", "--effort", "HIGH"],
            ["--effort", "default"],
            ["--effort", "unset"],
            ["--effort"],
            ["--effort", "bad"],
            ["--effort", "low", "--effort", "high"],
        ];
        var source = await SourceAsync(
            new JsonObject
            {
                ["operation"] = "parsers",
                ["create"] = JsonSerializer.SerializeToNode(creates),
                ["efforts"] = JsonSerializer.SerializeToNode(efforts),
                ["thresholds"] = new JsonArray(),
                ["moves"] = new JsonArray(),
                ["timers"] = new JsonArray(),
            }
        );
        for (var index = 0; index < creates.Length; index++)
        {
            var expected = source["create"]![index]!;
            if (expected["error"] is not null)
                Assert.Throws<InvalidDataException>(() =>
                    CommandArguments.SessionCreate(creates[index])
                );
            else
            {
                var actual = CommandArguments.SessionCreate(creates[index]);
                Assert.Equal(SessionWait.Text(expected["model"]), actual.Model);
                Assert.Equal(SessionWait.Text(expected["effort"]), actual.Effort);
                Assert.Equal(SessionWait.Strings(expected["systemPromptFiles"]), actual.Files);
            }
        }
        for (var index = 0; index < efforts.Length; index++)
        {
            var expected = source["efforts"]![index]!;
            if (expected["error"] is not null)
                Assert.Throws<InvalidDataException>(() => CommandArguments.Effort(efforts[index]));
            else
            {
                var actual = CommandArguments.Effort(efforts[index]);
                Assert.Equal(SessionWait.Strings(expected["remaining"]), actual.Remaining);
                Assert.Equal(SessionCatalog.Flag(expected["present"]), actual.Present);
                Assert.Equal(SessionWait.Text(expected["effort"]), actual.Effort);
            }
        }
    }

    [Fact]
    public async Task Shared_catalog_projects_hidden_handlers_autocomplete_and_completed_effects()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        await f.Router.HandleExternalMessageAsync(source, Message("/help"));
        var help = replies.Single();
        var telegram = ExternalCommands
            .TelegramCommands()
            .OfType<JsonObject>()
            .Select(row => "/" + row["command"])
            .ToArray();
        var web = ExternalCommands.WebUiCommands().OfType<JsonObject>().ToArray();
        Assert.Contains("/agent", telegram);
        Assert.DoesNotContain("/messages", telegram);
        Assert.DoesNotContain("`/messages`", help);
        Assert.DoesNotContain("/delete-messages", telegram);
        Assert.NotNull(ExternalCommands.Find("/delete-messages"));
        Assert.Contains("/btw", telegram);
        Assert.Contains("/verbose", telegram);
        Assert.True(ExternalCommands.Find("/messages")!["requiresSession"]!.GetValue<bool>());
        foreach (var name in new[] { "/tools", "/config", "/index", "/retry" })
            Assert.Null(ExternalCommands.Find(name));
        Assert.Equal(
            web.Select(row => row["name"]!.GetValue<string>()).Order(StringComparer.Ordinal),
            web.Select(row => row["name"]!.GetValue<string>())
        );
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
            ExternalCommands.Find("/compact")!["autocomplete"]!["children"]!.AsArray(),
            row => SessionWait.Text(row?["value"]) == "tools"
        );
        Assert.Contains(
            ExternalCommands.Find("/agent")!["autocomplete"]!["children"]!.AsArray(),
            row => SessionWait.Text(row?["value"]) == "delete"
        );
        f.Manager.AttachChannel(source.Target, f.Owner);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/messages -1"));
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
            Message("/session parent " + f.Owner.Id + " " + other.Id)
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
        await f.Router.HandleExternalMessageAsync(source, Message("/session unparent " + other.Id));
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
            Message("/agent create forbidden --no-main")
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
            Message("/agent create ordinary --no-main")
        );
        Assert.DoesNotContain("ordinary", f.Manager.Agents());
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Empty(replies);
        await f.Router.HandleExternalCommandAsync(
            unauthorized,
            "/agent",
            "create direct --no-main"
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
