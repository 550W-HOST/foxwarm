using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class AskUserTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Final(string text = "noted") =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = text }
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

    private static JsonObject Ask(string? afterAsk = null, bool multi = false)
    {
        var args = new JsonObject
        {
            ["questions"] = new JsonArray(
                new JsonObject
                {
                    ["question"] = "Which database should the service use?",
                    ["options"] = new JsonArray(
                        new JsonObject
                        {
                            ["label"] = "PostgreSQL",
                            ["description"] = "Shared server",
                            ["recommended"] = true,
                        },
                        new JsonObject { ["label"] = "SQLite" }
                    ),
                    ["multiSelect"] = multi,
                },
                new JsonObject { ["question"] = "Any naming preference?" }
            ),
        };
        if (afterAsk is not null)
            args["afterAsk"] = afterAsk;
        return args;
    }

    private sealed class Harness : IAsyncDisposable
    {
        internal ScriptFixture F = null!;
        internal ScriptedResponsesSequenceServer Peer = null!;
        internal readonly List<JsonObject> Requests = [];

        internal static async Task<Harness> Create(
            int requests,
            Func<Harness, int, JsonArray> reply
        )
        {
            var harness = new Harness();
            harness.Peer = new ScriptedResponsesSequenceServer(
                requests,
                async (index, stream, request) =>
                {
                    harness.Requests.Add(JsonNode.Parse(request.Body)!.AsObject());
                    await Respond(stream, reply(harness, index));
                }
            );
            harness.F = await ScriptFixture.Create(
                suppliedOptions: new ResponsesClientOptions(
                    harness.Peer.BaseUri,
                    "wire",
                    "a",
                    "",
                    "",
                    713
                )
            );
            return harness;
        }

        internal SessionOwner Owner => F.Owner;

        internal async Task Process()
        {
            await Owner
                .Registry.Runner.ProcessQueueAsync(Owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Null(Owner.Entry.LastBackgroundProcessorFailure);
        }

        internal async Task UserText(string text)
        {
            await Owner.Entry.SaveLane.AdmitAsync(
                new QueueItem(
                    QueueItemType.User,
                    SessionBoundary.ChannelInput([new JsonObject { ["text"] = text }], "webui"),
                    OpenFields: new JsonObject { ["userInput"] = true }
                ),
                SaveKind.BestEffort
            );
        }

        internal JsonObject Meta => Owner.Entry.Snapshot().Meta;

        internal string OnlyQuestionId() =>
            SessionWait.Text(SessionQuestions.Records(Meta).Single()["id"])!;

        internal string Input(int index) => Requests[index]["input"]!.ToJsonString();

        public async ValueTask DisposeAsync()
        {
            await F.DisposeAsync();
            await Peer.DisposeAsync();
        }
    }

    [Fact]
    public async Task Blocking_ask_waits_and_a_structured_answer_is_user_input_that_wins_once()
    {
        await using var h = await Harness.Create(
            2,
            (_, index) =>
                index == 0 ? new JsonArray(Call("ask", "ask_user", Ask())) : new JsonArray(Final())
        );
        await h.UserText("set up the service");
        await h.Process();
        Assert.Equal(1, h.Peer.RequestCount);
        var id = h.OnlyQuestionId();
        var record = SessionQuestions.Find(h.Meta, id)!;
        Assert.Equal("open", SessionQuestions.Status(record));
        Assert.Equal("ask", SessionWait.Text(record["toolCallId"]));
        Assert.Equal(new[] { id }, SessionWait.Strings(h.Owner.WaitSnapshot()!["waitQuestionIds"]));
        Assert.Null(h.Owner.WaitSnapshot()!["timeoutSeconds"]);
        var runtime = h.Owner.RuntimeSnapshot();
        Assert.Equal("waiting", SessionWait.Text(runtime["state"]));
        Assert.Equal("question", SessionWait.Text(runtime["waiting"]!["waitingFor"]));
        var projection = SessionQuestions.Projection(h.Meta)!;
        Assert.Equal(1, projection["open"]!.GetValue<int>());
        Assert.True(projection["waiting"]!.GetValue<bool>());
        var catalog = h.F.Manager.Catalog.Get(h.Owner.Id)!;
        Assert.Equal(1, SessionCatalog.Number(catalog["meta"]!["questions"]!["open"]));
        Assert.True(SessionCatalog.Flag(catalog["meta"]!["questions"]!["waiting"]));
        Assert.Contains(
            h.F.Manager.Catalog.QuestionRows(10),
            row => SessionCatalog.Text(row["id"]) == h.Owner.Id
        );
        var toolResult = h
            .Owner.History()
            .SelectMany(row => row["parts"]!.AsArray().OfType<JsonObject>())
            .Select(part => part["functionResponse"]?["response"] as JsonObject)
            .OfType<JsonObject>()
            .Single();
        Assert.Equal(id, SessionWait.Text(toolResult["questionId"]));

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            h.F.Manager.AnswerQuestionAsync(
                h.Owner,
                id,
                new JsonObject
                {
                    ["answers"] = new JsonArray(
                        new JsonObject { ["selected"] = new JsonArray("PostgreSQL", "SQLite") },
                        new JsonObject()
                    ),
                }
            )
        );
        await h.F.Manager.AnswerQuestionAsync(
            h.Owner,
            id,
            new JsonObject
            {
                ["answers"] = new JsonArray(
                    new JsonObject { ["selected"] = new JsonArray("PostgreSQL") },
                    new JsonObject { ["text"] = "svc-data" }
                ),
                ["note"] = "Keep backups.",
            }
        );
        Assert.Equal("answered", SessionQuestions.Status(SessionQuestions.Find(h.Meta, id)!));
        Assert.Null(h.Owner.WaitSnapshot());
        Assert.Null(SessionQuestions.Projection(h.Meta)!["waiting"]);
        await Assert.ThrowsAsync<QuestionNotOpenException>(() =>
            h.F.Manager.AnswerQuestionAsync(h.Owner, id, new JsonObject { ["skip"] = true })
        );
        await h.Process();
        Assert.Equal(2, h.Peer.RequestCount);
        var input = h.Input(1);
        Assert.Contains("Answer to question " + id, input);
        Assert.Contains("PostgreSQL", input);
        Assert.Contains("svc-data", input);
        Assert.Contains("Keep backups.", input);
        Assert.DoesNotContain("question-reminder", input);
        var answerRow = h
            .Owner.History()
            .Last(row =>
                SessionWait.Text(row["role"]) == "user"
                && row["__meta"]?["questionAnswer"] is not null
            );
        var answerMeta = answerRow["__meta"]!["questionAnswer"]!;
        Assert.Equal(id, SessionWait.Text(answerMeta["questionId"]));
        Assert.Equal(
            SessionWait.Strings(answerMeta["questions"]).Length,
            answerMeta["answers"]!.AsArray().Count
        );
        Assert.All(SessionWait.Strings(answerMeta["questions"]), text => Assert.NotEmpty(text));
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(h.F.Data, "state", "sessions", h.Owner.Id + ".json")
            )
        )!["meta"]!["questions"]!;
        Assert.Equal("answered", SessionWait.Text(persisted["items"]![0]!["status"]));
        Assert.Null(persisted["items"]![0]!["answer"]!["questions"]);
    }

    [Fact]
    public async Task Ordinary_user_message_answers_the_waited_question_but_other_input_does_not()
    {
        await using var h = await Harness.Create(
            2,
            (_, index) =>
                index == 0 ? new JsonArray(Call("ask", "ask_user", Ask())) : new JsonArray(Final())
        );
        await h.UserText("start");
        await h.Process();
        var id = h.OnlyQuestionId();
        // A Session event is not user input: it wakes the Session but leaves the question open.
        await h.Owner.Entry.SaveLane.AdmitAsync(
            new QueueItem(
                QueueItemType.Intersession,
                [new JsonObject { ["system"] = "report" }],
                SourceSessionId: "main/other"
            ),
            SaveKind.Strict
        );
        Assert.Equal("open", SessionQuestions.Status(SessionQuestions.Find(h.Meta, id)!));
        Assert.Null(h.Owner.WaitSnapshot());
        await h.Owner.Entry.SaveLane.ClearWaitAsync();
        h.Owner.Entry.WithState(state => state.Queue.Clear());
        await h.F.Manager.DeclareWaitAsync(
            h.Owner,
            new JsonObject { ["waitQuestionIds"] = new JsonArray(id) }
        );
        await h.UserText("Use SQLite for now.");
        var record = SessionQuestions.Find(h.Meta, id)!;
        Assert.Equal("answered", SessionQuestions.Status(record));
        Assert.Equal("Use SQLite for now.", SessionWait.Text(record["answer"]!["text"]));
        await h.Process();
        var input = h.Input(1);
        Assert.Contains("Use SQLite for now.", input);
        Assert.Contains("question-answer", input);
        Assert.Contains(id, input);
    }

    [Fact]
    public async Task Asynchronous_question_keeps_working_with_reminder_and_close()
    {
        await using var h = await Harness.Create(
            3,
            (harness, index) =>
                index switch
                {
                    0 => new JsonArray(Call("ask", "ask_user", Ask("continue"))),
                    1 => new JsonArray(
                        Call(
                            "close",
                            "ask_user",
                            new JsonObject
                            {
                                ["close"] = harness.OnlyQuestionId(),
                                ["closeNote"] = "Answered in conversation.",
                            }
                        )
                    ),
                    _ => new JsonArray(Final()),
                }
        );
        await h.UserText("start");
        await h.Process();
        Assert.Equal(3, h.Peer.RequestCount);
        var id = h.OnlyQuestionId();
        Assert.Contains("question-reminder", h.Input(1));
        Assert.Contains("not waited on", h.Input(1));
        Assert.DoesNotContain("question-reminder", h.Input(2));
        var record = SessionQuestions.Find(h.Meta, id)!;
        Assert.Equal("closed", SessionQuestions.Status(record));
        Assert.Equal("Answered in conversation.", SessionWait.Text(record["closeNote"]));
        Assert.Null(h.Owner.WaitSnapshot());
        Assert.Equal(0, SessionQuestions.Projection(h.Meta)!["open"]!.GetValue<int>());
        Assert.Empty(h.F.Manager.Catalog.QuestionRows(10));
    }

    [Fact]
    public async Task Sibling_error_suppresses_the_ask_wait_but_keeps_the_question_open()
    {
        await using var h = await Harness.Create(
            2,
            (harness, index) =>
                index == 0
                    ? new JsonArray(
                        Call("ask", "ask_user", Ask()),
                        Call("failed", "read", new JsonObject { ["filePath"] = "missing.txt" })
                    )
                    : new JsonArray(Final())
        );
        await h.UserText("start");
        await h.Process();
        Assert.Equal(2, h.Peer.RequestCount);
        Assert.Null(h.Owner.WaitSnapshot());
        Assert.Equal(
            "open",
            SessionQuestions.Status(SessionQuestions.Find(h.Meta, h.OnlyQuestionId())!)
        );
        Assert.Contains("question-reminder", h.Input(1));
    }

    [Fact]
    public async Task Open_question_and_its_wait_survive_restart()
    {
        await using var h = await Harness.Create(
            1,
            (_, _) => new JsonArray(Call("ask", "ask_user", Ask()))
        );
        await h.UserText("start");
        await h.Process();
        var id = h.OnlyQuestionId();
        var sessionId = h.Owner.Id;
        await h.F.Manager.ShutdownAsync();
        await h.F.Manager.DisposeAsync();
        var options = new ResponsesClientOptions(h.Peer.BaseUri, "wire", "a", "", "", 713);
        h.F.Manager = new SessionManager(h.F.Data, h.F.Work, options, HostModels.ForTest(options));
        await h.F.Manager.LoadMainHostAsync();
        var row = h.F.Manager.Catalog.Get(sessionId)!;
        Assert.True(SessionCatalog.Flag(row["meta"]!["questions"]!["waiting"]));
        var owner = (await h.F.Manager.GetExistingAsync(sessionId))!;
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var view = h.F.Manager.QuestionsView(owner);
        Assert.Equal(id, SessionWait.Text(view["questions"]![0]!["id"]));
        Assert.Equal("open", SessionWait.Text(view["questions"]![0]!["status"]));
        Assert.Equal(new[] { id }, SessionWait.Strings(view["waitingQuestionIds"]));
        await h.F.Manager.AnswerQuestionAsync(owner, id, new JsonObject { ["skip"] = true });
        Assert.Equal(
            "skipped",
            SessionQuestions.Status(SessionQuestions.Find(owner.Entry.Snapshot().Meta, id)!)
        );
        Assert.Contains(
            "skipped question " + id,
            owner.Entry.Snapshot().Queue.Single().Parts![0]["system"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Arguments_and_wait_sources_are_validated()
    {
        await using var f = await ScriptFixture.Create();
        async Task<string?> Error(JsonObject args)
        {
            try
            {
                await f.Manager.AskUserAsync(f.Owner, args, null);
                return null;
            }
            catch (Exception error)
                when (error is InvalidDataException or InvalidOperationException)
            {
                return error.Message;
            }
        }
        Assert.NotNull(await Error(new JsonObject()));
        var both = Ask();
        both["close"] = "q-x";
        Assert.NotNull(await Error(both));
        Assert.NotNull(
            await Error(
                new JsonObject
                {
                    ["questions"] = new JsonArray(
                        Enumerable
                            .Range(0, 5)
                            .Select(i => (JsonNode?)new JsonObject { ["question"] = "q" + i })
                            .ToArray()
                    ),
                }
            )
        );
        Assert.NotNull(
            await Error(
                new JsonObject
                {
                    ["questions"] = new JsonArray(
                        new JsonObject
                        {
                            ["question"] = "dup",
                            ["options"] = new JsonArray(
                                new JsonObject { ["label"] = "a" },
                                new JsonObject { ["label"] = "a" }
                            ),
                        }
                    ),
                }
            )
        );
        Assert.NotNull(await Error(new JsonObject { ["close"] = "q-missing" }));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.DeclareWaitAsync(
                f.Owner,
                new JsonObject { ["waitQuestionIds"] = new JsonArray("q-missing") }
            )
        );
        var asked = await f.Manager.AskUserAsync(f.Owner, Ask("continue"), null);
        Assert.Null(asked.WaitQuestionId);
        var id = SessionWait.Text(asked.Response["questionId"])!;
        await f.Manager.DeclareWaitAsync(
            f.Owner,
            new JsonObject { ["waitQuestionIds"] = new JsonArray(id), ["reason"] = "decision" }
        );
        var wait = f.Owner.WaitSnapshot()!;
        Assert.Equal(new[] { id }, SessionWait.Strings(wait["waitQuestionIds"]));
        Assert.Null(wait["timeoutSeconds"]);
        var listed = new SessionListQueries(new SessionRuntime(f.Manager)).QuestionSessions(10);
        Assert.Equal(f.Owner.Id, SessionWait.Text(listed[0]!["id"]));
        Assert.True(listed[0]!["questions"]!["waiting"]!.GetValue<bool>());
    }

    [Fact]
    public void Channel_text_lists_numbered_options_with_descriptions()
    {
        var record = new JsonObject
        {
            ["questions"] = SessionQuestions.ParseQuestions(Ask()["questions"]),
        };
        var text = SessionQuestions.ChannelText(record);
        Assert.Contains("1. Which database should the service use?", text);
        Assert.Contains("1) PostgreSQL (recommended) — Shared server", text);
        Assert.Contains("2) SQLite", text);
        Assert.Contains("2. Any naming preference?", text);
    }
}
