using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // A restricted Agent that may ask the user questions and nothing else.
    private const string AskerRules = """
        [
          {"tool":{"source":"builtin","name":"ask_user"},"action":"allow"},
          {"action":"deny"}
        ]
        """;

    private static JsonObject SecretQuestion(string name, string question = "Paste the token.") =>
        Obj(
            $$$"""{"questions":[{"question":"{{{question}}}","secret":{"name":"{{{name}}}"}}],"afterAsk":"continue"}"""
        );

    private static string QueuedAnswerText(SessionOwner owner) =>
        owner.Entry.WithState(state =>
            string.Join(
                "\n",
                state
                    .Queue.Where(item => item.OpenFields?["questionAnswer"] is not null)
                    .SelectMany(item => item.Parts ?? [])
                    .Select(part =>
                        SessionWait.Text(part["text"]) ?? SessionWait.Text(part["system"])
                    )
            )
        );

    private static void NoFileContains(string root, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            Assert.False(
                File.ReadAllBytes(file).AsSpan().IndexOf(bytes) >= 0,
                "The secret value was written to " + file
            );
    }

    [Fact]
    public async Task Secret_questions_store_the_answer_for_the_asking_Agent_and_tell_it_only_the_name()
    {
        await using var f = await ConfigurationFixture();
        var store = f.Configuration.Secrets.Store;
        store.Set("provider-key", "synthetic-provider-secret-0101");
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ProviderModels });
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ModelsWithPendingSecret });
        var asker = await ChildAgent(f, "asker", rules: Rules(AskerRules));
        Task<JsonNode?> Ask(SessionOwner owner, JsonObject args) =>
            f.ToolAsync("ask_user", args, owner);

        // Filling a referenced name is a secret fact of the question, as for add_secret.
        var pending = await Ask(asker, SecretQuestion("pending-key"));
        Assert.Equal("tool_authorization_denied", SessionWait.Text(pending?["error"]?["type"]));
        Assert.Contains("`pending-key`", ErrorMessage(pending));
        Assert.Contains(
            "already exists",
            ErrorMessage(await Ask(asker, SecretQuestion("provider-key")))
        );
        foreach (
            var invalid in new[]
            {
                """{"questions":[{"question":"Token?","secret":{"name":"ci-token"},"options":[{"label":"none"}]}]}""",
                """{"questions":[{"question":"Token?","secret":{"name":"Bad Name"}}]}""",
                """{"questions":[{"question":"Token?","secret":{"name":"ci-token","value":"x"}}]}""",
                """{"questions":[{"question":"A?","secret":{"name":"ci-token"}},{"question":"B?","secret":{"name":"ci-token"}}]}""",
            }
        )
            Denied(await Ask(asker, Obj(invalid)));
        Assert.Empty(SessionQuestions.Records(asker.Entry.Snapshot().Meta));

        // A secret question beside an ordinary one; the Session waits for both.
        var asked = Output(
            await Ask(
                asker,
                Obj(
                    """{"questions":[{"question":"Paste the CI token.","secret":{"name":"ci-token","description":"CI token"}},{"question":"Which repository?"}]}"""
                )
            )
        );
        var id = SessionWait.Text(asked["questionId"])!;
        JsonObject Record() => SessionQuestions.Find(asker.Entry.Snapshot().Meta, id)!;
        Assert.Equal(
            """{"name":"ci-token","description":"CI token"}""",
            Record()["questions"]![0]!["secret"]!.ToJsonString()
        );
        Assert.Equal(new[] { id }, SessionWait.Strings(asker.WaitSnapshot()!["waitQuestionIds"]));
        var channel = SessionQuestions.ChannelText(Record());
        Assert.Contains("Secret `ci-token`: enter it in the WebUI.", channel);
        Assert.EndsWith("Answer in the WebUI.", channel);
        Assert.DoesNotContain("Reply to answer", channel);

        // A message wakes the Session but never answers a question set that asks for a secret.
        await asker.Entry.SaveLane.AdmitAsync(
            new QueueItem(
                QueueItemType.User,
                SessionBoundary.ChannelInput(
                    [new JsonObject { ["text"] = "The token is in the vault." }],
                    "webui"
                ),
                OpenFields: new JsonObject { ["userInput"] = true }
            ),
            SaveKind.BestEffort
        );
        Assert.Equal("open", SessionQuestions.Status(Record()));
        Assert.Null(asker.WaitSnapshot());

        // Answers carry the value only for the secret question.
        foreach (
            var invalid in new[]
            {
                """{"answers":[{"text":"not a value"},{}]}""",
                """{"answers":[{"value":7},{}]}""",
            }
        )
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.AnswerQuestionAsync(asker, id, Obj(invalid))
            );
        Assert.False(store.Contains("ci-token"));

        const string Token = "synthetic-ci-token-0606";
        await f.Manager.AnswerQuestionAsync(
            asker,
            id,
            Obj($$"""{"answers":[{"value":"{{Token}}"},{"text":"foxwarm"}]}"""),
            InputSender.Identity("viewer")
        );
        Assert.Equal(Token, store.Resolve("ci-token"));
        Assert.Equal("asker", store.Owner("ci-token"));
        Assert.Equal("CI token", store.List().Single(item => item.Name == "ci-token").Description);
        Assert.Equal("answered", SessionQuestions.Status(Record()));
        Assert.Equal(
            """[{"secret":"ci-token","stored":true},{"text":"foxwarm"}]""",
            Record()["answer"]!["answers"]!.ToJsonString()
        );
        var answerText = QueuedAnswerText(asker);
        Assert.Contains("(stored as secret `ci-token`)", answerText);
        Assert.Contains("foxwarm", answerText);
        Assert.DoesNotContain(Token, answerText);
        await Assert.ThrowsAsync<QuestionNotOpenException>(() =>
            f.Manager.AnswerQuestionAsync(
                asker,
                id,
                Obj("""{"answers":[{"value":"another-value-0707"},{}]}""")
            )
        );
        Assert.Equal(Token, store.Resolve("ci-token"));
        Assert.Contains(
            "already exists",
            ErrorMessage(await Ask(asker, SecretQuestion("ci-token")))
        );

        // A name configuration already uses can be filled only by the administrator.
        var filled = Output(await Ask(f.Owner, SecretQuestion("pending-key")));
        var pendingId = SessionWait.Text(filled["questionId"])!;
        var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.AnswerQuestionAsync(
                f.Owner,
                pendingId,
                Obj("""{"answers":[{"value":"synthetic-pending-0808"}]}"""),
                InputSender.Identity("viewer")
            )
        );
        Assert.Contains("Only the administrator", refused.Message);
        Assert.False(store.Contains("pending-key"));
        await f.Manager.AnswerQuestionAsync(
            f.Owner,
            pendingId,
            Obj("""{"answers":[{"value":"synthetic-pending-0808"}]}"""),
            InputSender.Administrator()
        );
        Assert.Equal("synthetic-pending-0808", store.Resolve("pending-key"));
        Assert.Equal("main", store.Owner("pending-key"));

        // Values reach the store only: no Session state, catalog or log holds them.
        NoFileContains(f.Data, Token);
        NoFileContains(f.Data, "synthetic-pending-0808");
    }
}
