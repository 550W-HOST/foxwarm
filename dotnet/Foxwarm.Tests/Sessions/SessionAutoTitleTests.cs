using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionAutoTitleTests
{
    [Theory]
    [InlineData("Fix Nginx Config", "Fix Nginx Config")]
    [InlineData("\"Fix Nginx Config.\"", "Fix Nginx Config")]
    [InlineData("Title: **Deploy   the app**\nextra commentary", "Deploy the app")]
    [InlineData("## 标题：「整理下载目录」。", "整理下载目录")]
    [InlineData("  \n\n  ", null)]
    [InlineData("\"\"", null)]
    public void Normalize_returns_one_clean_line(string raw, string? expected) =>
        Assert.Equal(expected, SessionAutoTitle.Normalize(raw));

    [Fact]
    public void Normalize_limits_display_width_for_latin_and_wide_text()
    {
        var latin = SessionAutoTitle.Normalize(string.Join(' ', Enumerable.Repeat("word", 30)))!;
        Assert.True(SessionAutoTitle.Width(latin) <= SessionAutoTitle.MaxWidth);
        Assert.EndsWith("…", latin);
        var wide = SessionAutoTitle.Normalize(new string('字', 40))!;
        Assert.True(SessionAutoTitle.Width(wide) <= SessionAutoTitle.MaxWidth);
        Assert.Equal(SessionAutoTitle.MaxWidth / 2 - 1, wide.Length - 1);
        Assert.Equal("整理下载目录", SessionAutoTitle.Normalize("整理下载目录"));
    }

    [Fact]
    public void Select_uses_the_first_direct_input_and_this_turns_reply_after_a_prepared_greeting()
    {
        var history = History(
            Reply(1, "Welcome! Ask me anything."),
            Input(2, SessionTag(), Channel("Please clean up my downloads folder")),
            Reply(3, "", tool: true),
            Tool(4),
            Reply(5, "I sorted 42 files into folders.")
        );
        var selection = SessionAutoTitle.Select(history, 2);
        Assert.Equal(SessionAutoTitle.Outcome.Ready, selection.Outcome);
        Assert.Equal("Please clean up my downloads folder", selection.Exchange!.UserText);
        Assert.Equal("I sorted 42 files into folders.", selection.Exchange.ReplyText);
        Assert.Contains(
            "Please clean up my downloads folder",
            SessionAutoTitle.RequestMessage(selection.Exchange).ToJsonString()
        );
    }

    [Fact]
    public void Select_accepts_a_first_turn_completed_after_an_earlier_failed_attempt()
    {
        var history = History(
            Input(1, SessionTag(), Channel("hello")),
            Notice(2),
            Input(3, Channel("are you there?")),
            Reply(4, "Yes, I am here.")
        );
        var selection = SessionAutoTitle.Select(history, 3);
        Assert.Equal(SessionAutoTitle.Outcome.Ready, selection.Outcome);
        Assert.Equal("hello", selection.Exchange!.UserText);
    }

    [Fact]
    public void Select_rejects_later_turns_handoffs_and_waits_without_text()
    {
        var later = History(
            Input(1, Channel("first")),
            Reply(2, "first reply"),
            Input(3, Channel("second")),
            Reply(4, "second reply")
        );
        Assert.Equal(
            SessionAutoTitle.Outcome.Ineligible,
            SessionAutoTitle.Select(later, 3).Outcome
        );

        var child = History(
            Input(
                1,
                new JsonObject
                {
                    ["system"] = "<foxwarm-system kind=\"session-boundary\" event=\"new-child\" />",
                },
                new JsonObject
                {
                    ["system"] =
                        "<foxwarm-message type=\"task\" taskId=\"t\">do it</foxwarm-message>",
                }
            ),
            Reply(2, "done")
        );
        Assert.Equal(
            SessionAutoTitle.Outcome.Ineligible,
            SessionAutoTitle.Select(child, 1).Outcome
        );

        var external = History(
            Input(
                1,
                new JsonObject
                {
                    ["system"] = "<foxwarm-system kind=\"external-input\" server=\"s\">",
                },
                new JsonObject { ["text"] = "hi" },
                new JsonObject { ["system"] = "</foxwarm-system>" }
            ),
            Reply(2, "done")
        );
        Assert.Equal(
            SessionAutoTitle.Outcome.Ineligible,
            SessionAutoTitle.Select(external, 1).Outcome
        );

        var internalSubmission = History(
            Input(1, new JsonObject { ["text"] = "fork initial message" }),
            Reply(2, "done")
        );
        Assert.Equal(
            SessionAutoTitle.Outcome.Ineligible,
            SessionAutoTitle.Select(internalSubmission, 1).Outcome
        );

        var waiting = History(Input(1, Channel("start")), Reply(2, "", tool: true), Tool(3));
        Assert.Equal(SessionAutoTitle.Outcome.Pending, SessionAutoTitle.Select(waiting, 1).Outcome);
    }

    [Fact]
    public async Task First_completed_user_turn_titles_an_unnamed_Session_once_outside_its_history()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
                await SendAsync(
                    stream,
                    index switch
                    {
                        0 => "Use `nginx -t` first.",
                        1 => "\"Check Nginx Config.\"",
                        _ => "Second answer.",
                    }
                )
        );
        await using var f = await FixtureAsync(peer.BaseUri);
        var owner = await f.Manager.CreateNamedAsync("main", "plain", null, null);
        var states = new ConcurrentQueue<string?>();
        f.Manager.Changed += value =>
        {
            if (value.SessionId == owner.Id && value.Kind == SessionEventKind.StateChanged)
                states.Enqueue(owner.Metadata().DisplayName);
        };
        await RunUserTurnAsync(f.Manager, owner, "How do I check my nginx config?");
        var pending = owner.AutoTitle.Pending;
        Assert.NotNull(pending);
        await pending.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal("Check Nginx Config", owner.Metadata().DisplayName);
        Assert.Equal(
            "Check Nginx Config",
            SessionCatalog.Text(f.Manager.Catalog.Get(owner.Id)?["displayName"])
        );
        Assert.Contains("Check Nginx Config", states);
        var title = JsonNode.Parse((await peer.RequestAt(1)).Body)!.AsObject();
        Assert.Equal(SessionAutoTitle.Instructions, title["instructions"]?.ToString());
        Assert.True(title["tools"] is null || title["tools"]!.AsArray().Count == 0);
        var input = string.Concat(
            title["input"]!
                .AsArray()
                .SelectMany(item => item!["content"]!.AsArray())
                .Select(part => part!["text"]?.ToString())
        );
        Assert.Single(title["input"]!.AsArray());
        Assert.Contains("How do I check my nginx config?", input);
        Assert.Contains("Use `nginx -t` first.", input);
        Assert.DoesNotContain("foxwarm-message", input);
        Assert.DoesNotContain("currentSessionId", input);
        // The title exchange is not part of the Session conversation.
        var history = owner.History();
        Assert.Single(history, row => row["role"]?.ToString() == "model");
        Assert.DoesNotContain(history, row => row.ToJsonString().Contains("Check Nginx Config"));
        var manifests = await f.Manager.Journal.ListAsync(
            owner.Id,
            SessionAutoTitle.JournalPurpose,
            null,
            null,
            10
        );
        Assert.Single(manifests);

        await RunUserTurnAsync(f.Manager, owner, "And reload it?");
        Assert.Same(pending, owner.AutoTitle.Pending);
        Assert.Equal(3, peer.RequestCount);
        Assert.Equal("Check Nginx Config", owner.Metadata().DisplayName);
    }

    [Fact]
    public async Task Named_Sessions_and_names_set_during_the_request_are_preserved()
    {
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                if (index == 2)
                {
                    reached.TrySetResult();
                    await release.Task;
                    await SendAsync(stream, "Generated Title");
                    return;
                }
                await SendAsync(stream, "answer");
            }
        );
        await using var f = await FixtureAsync(peer.BaseUri);
        var named = await f.Manager.CreateNamedAsync("main", "named", "Chosen name", null);
        await RunUserTurnAsync(f.Manager, named, "hello");
        Assert.Null(named.AutoTitle.Pending);
        Assert.True(named.AutoTitle.Settled);
        Assert.Equal("Chosen name", named.Metadata().DisplayName);

        var racing = await f.Manager.CreateNamedAsync("main", "racing", null, null);
        try
        {
            await RunUserTurnAsync(f.Manager, racing, "hello again");
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await new SessionRuntime(f.Manager).UpdateDisplayNameAsync(racing.Id, "User label");
            release.TrySetResult();
            await racing.AutoTitle.Pending!.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal("User label", racing.Metadata().DisplayName);
            Assert.Equal(3, peer.RequestCount);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Failed_title_request_is_silent_single_attempt_and_not_retried_later()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                if (index == 1)
                {
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        503,
                        "application/json",
                        "{\"error\":\"temporary\"}"u8.ToArray()
                    );
                    return;
                }
                await SendAsync(stream, "answer " + index);
            }
        );
        await using var f = await FixtureAsync(peer.BaseUri);
        var owner = await f.Manager.CreateNamedAsync("main", "failing", null, null);
        await RunUserTurnAsync(f.Manager, owner, "first");
        await owner.AutoTitle.Pending!.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(2, peer.RequestCount);
        Assert.Null(owner.Metadata().DisplayName);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(0, owner.Entry.BestEffortFailureCount);
        Assert.DoesNotContain(owner.History(), row => row["__meta"]?["noticeType"] is not null);
        Assert.Single(
            await f.Manager.Journal.ListAsync(
                owner.Id,
                SessionAutoTitle.JournalPurpose,
                null,
                null,
                10
            )
        );

        await RunUserTurnAsync(f.Manager, owner, "second");
        Assert.Equal(3, peer.RequestCount);
        Assert.Null(owner.Metadata().DisplayName);
    }

    private static async Task RunUserTurnAsync(
        SessionManager manager,
        SessionOwner owner,
        string text
    )
    {
        await new SessionRuntime(manager).SubmitAndRunAsync(
            owner.Id,
            new QueueItem(
                QueueItemType.User,
                SessionBoundary.ChannelInput([new JsonObject { ["text"] = text }], "webui")
            )
        );
        await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
    }

    private static Task SendAsync(NetworkStream stream, string text) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["output"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "message",
                                    ["role"] = "assistant",
                                    ["content"] = new JsonArray(
                                        new JsonObject { ["type"] = "output_text", ["text"] = text }
                                    ),
                                }
                            ),
                        },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    private sealed class Fixture(TempDirectory temp, SessionManager manager) : IAsyncDisposable
    {
        internal SessionManager Manager => manager;

        public async ValueTask DisposeAsync()
        {
            await manager.DisposeAsync();
            temp.Dispose();
        }
    }

    private static async Task<Fixture> FixtureAsync(Uri provider)
    {
        var temp = new TempDirectory();
        var options = new ResponsesClientOptions(provider, "wire", "a", "", "", 713);
        var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        return new(temp, manager);
    }

    private static SessionHistory History(params JsonObject[] rows) =>
        SessionHistory.FromJson(rows);

    private static JsonObject Meta(long seq) => new() { ["seq"] = seq, ["timestamp"] = 1 };

    private static JsonObject SessionTag() =>
        new() { ["system"] = "<foxwarm-system kind=\"session\" currentSessionId=\"s\" />" };

    private static JsonObject Channel(string text) =>
        SessionBoundary.ChannelInput([new JsonObject { ["text"] = text }], "webui")[0];

    private static JsonObject Input(long seq, params JsonObject[] parts) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray()),
            ["__meta"] = Meta(seq),
        };

    private static JsonObject Reply(long seq, string text, bool tool = false)
    {
        var parts = new JsonArray();
        if (text.Length > 0)
            parts.Add(new JsonObject { ["text"] = text });
        if (tool)
            parts.Add(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["name"] = "wait",
                        ["args"] = new JsonObject(),
                    },
                }
            );
        return new()
        {
            ["role"] = "model",
            ["parts"] = parts,
            ["__meta"] = Meta(seq),
        };
    }

    private static JsonObject Tool(long seq) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = "wait",
                        ["response"] = new JsonObject(),
                    },
                }
            ),
            ["__meta"] = Meta(seq),
        };

    private static JsonObject Notice(long seq) =>
        new()
        {
            ["role"] = "model",
            ["modelVisible"] = false,
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "request failed" }),
            ["__meta"] = new JsonObject { ["seq"] = seq, ["noticeType"] = "llm-retry" },
        };
}
