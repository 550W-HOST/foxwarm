using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

// Redaction statistics recorded per attempt, their usage aggregation, and the memory-only
// sent-version view.
public sealed partial class TextRedactionObservabilityTests
{
    private const string Person = "Alice Zhang";
    private const string Phone = "13800138000";
    private static readonly long[] Always = [0, 9_999_999_999_999];

    private static JsonObject AnthropicProvider(Uri baseUri, Uri detector) =>
        new()
        {
            ["providerType"] = "anthropic",
            ["baseUrl"] = baseUri.ToString(),
            ["extraFields"] = new JsonObject { ["stream"] = false },
            ["models"] = new JsonArray("m"),
            ["textRedaction"] = TextRedactionTests.Settings(detector),
        };

    private static Task AnswerAsync(System.Net.Sockets.NetworkStream connection, string text) =>
        LoopbackResponsesServer.WriteResponseAsync(
            connection,
            200,
            "application/json",
            Encoding.UTF8.GetBytes(
                new JsonObject
                {
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "text", ["text"] = text }
                    ),
                    ["stop_reason"] = "end_turn",
                }.ToJsonString()
            )
        );

    private static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    // A detector that flags the person everywhere except in texts containing "again", where
    // it reports only the phone number, so the person there is masked literally.
    private static async Task<TextDetectionPeer> DetectorAsync()
    {
        var detector = await TextDetectionPeer.StartAsync(Person, Phone);
        detector.Labels[Person] = "private_person";
        detector.Labels[Phone] = "private_phone";
        return detector;
    }

    private static void OnlyPhoneWhenRepeated(TextDetectionPeer detector) =>
        detector.Intercept = async (context, text) =>
        {
            if (!text.Contains("again", StringComparison.Ordinal))
                return false;
            var entities = new JsonArray();
            var index = text.IndexOf(Phone, StringComparison.Ordinal);
            if (index >= 0)
            {
                var start = Encoding.UTF8.GetByteCount(text[..index]);
                entities.Add(
                    new JsonObject
                    {
                        ["start"] = start,
                        ["end"] = start + Phone.Length,
                        ["score"] = 0.9,
                        ["label"] = "private_phone",
                    }
                );
            }
            await context.Response.WriteAsJsonAsync(
                new JsonObject
                {
                    ["entities"] = entities,
                    ["offset_unit"] = "utf8_bytes",
                    ["input_bytes"] = Encoding.UTF8.GetByteCount(text),
                    ["input_tokens"] = text.Length,
                }
            );
            return true;
        };

    private sealed class Harness : IAsyncDisposable
    {
        internal required TextDetectionPeer Detector { get; init; }
        internal required ScriptedResponsesSequenceServer Provider { get; init; }
        internal required HttpClient Http { get; init; }
        internal required TempDirectory Temp { get; init; }
        internal required LlmRequestJournalStore Journal { get; init; }
        internal required TextRedactionKeys Keys { get; init; }
        internal required HostModels Catalog { get; init; }

        internal Task<ChatResult> RequestAsync(params JsonObject[] history) =>
            new ModelRequestOwner(
                Http,
                new(Provider.BaseUri, "m", "p/m", "", "", 100),
                new(),
                (_, _) => Task.CompletedTask,
                journal: Journal,
                secrets: Keys.Secrets
            ).RequestAsync(
                "s",
                Catalog,
                "p/m",
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                journalPurpose: "normal-turn"
            );

        public async ValueTask DisposeAsync()
        {
            Journal.Dispose();
            Keys.Dispose();
            Temp.Dispose();
            Http.Dispose();
            await Provider.DisposeAsync();
            await Detector.DisposeAsync();
        }
    }

    private static async Task<Harness> StartAsync()
    {
        var detector = await DetectorAsync();
        var provider = new ScriptedResponsesSequenceServer(
            8,
            async (_, connection, _) => await AnswerAsync(connection, "ok")
        );
        var temp = new TempDirectory();
        return new Harness
        {
            Detector = detector,
            Provider = provider,
            Http = ProviderHttpRequest.CreateClient(),
            Temp = temp,
            Journal = new LlmRequestJournalStore(temp.Path),
            Keys = new TextRedactionKeys(),
            Catalog = HostModels.Parse(
                new JsonObject
                {
                    ["providers"] = new JsonObject
                    {
                        ["p"] = AnthropicProvider(provider.BaseUri, detector.Endpoint),
                    },
                },
                new()
            ),
        };
    }

    [Fact]
    public async Task Attempts_record_detected_and_literal_counts_without_originals()
    {
        await using var harness = await StartAsync();
        OnlyPhoneWhenRepeated(harness.Detector);
        var first = User("Hello " + Person + ", call " + Phone);
        var result = await harness.RequestAsync(first);
        var meta = result.AssistantMessage!["__meta"]!["textRedaction"]!.AsObject();
        Assert.Equal(2, meta["replaced"]!.GetValue<int>());
        Assert.Equal(1, meta["labels"]!["private_person"]!["detected"]!.GetValue<int>());
        Assert.Equal(1, meta["labels"]!["private_phone"]!["detected"]!.GetValue<int>());
        Assert.Equal(1, meta["slots"]!.GetValue<int>());
        Assert.Equal(0, meta["cachedSlots"]!.GetValue<int>());
        Assert.Equal(1, meta["detectorCalls"]!.GetValue<int>());
        Assert.True(meta["detectionMs"]!.GetValue<double>() >= 0);
        Assert.DoesNotContain(Person, meta.ToJsonString());
        Assert.DoesNotContain(TextRedactor.Prefix, meta.ToJsonString());

        // The unchanged first message is served from the cache; the person in the new one is
        // missed by detection and masked literally.
        var second = await harness.RequestAsync(
            first,
            result.AssistantMessage!,
            User(Phone + " then " + Person + " again")
        );
        var again = second.AssistantMessage!["__meta"]!["textRedaction"]!.AsObject();
        Assert.Equal(4, again["replaced"]!.GetValue<int>());
        Assert.Equal(1, again["labels"]!["private_person"]!["literal"]!.GetValue<int>());
        Assert.Equal(3, again["slots"]!.GetValue<int>());
        Assert.Equal(1, again["cachedSlots"]!.GetValue<int>());
        Assert.Equal(2, again["detectorCalls"]!.GetValue<int>());

        var cells = harness.Journal.QueryRedaction(Always, "model_key");
        var cell = Assert.Single(cells);
        Assert.Equal("p/m", cell.Key);
        Assert.Equal(2, cell.Attempts);
        Assert.Equal(5, cell.Detected);
        Assert.Equal(1, cell.Literal);
        Assert.Equal(4, cell.Slots);
        Assert.Equal(1, cell.CachedSlots);
        Assert.Equal(3, cell.DetectorCalls);
        Assert.Equal(3, cell.Labels["private_person"]);
        Assert.Equal(3, cell.Labels["private_phone"]);
        Assert.Empty(cell.Failures);
        var bySession = Assert.Single(
            harness.Journal.QueryRedaction(Always, null, bySession: true)
        );
        Assert.Equal("s", bySession.SessionId);
        Assert.Equal(["s"], harness.Journal.RedactionSessions(Always[0], Always[1]));

        // Nothing in the database holds the originals because of this table.
        using var db = new Microsoft.Data.Sqlite.SqliteConnection(
            "Data Source=" + Path.Combine(harness.Temp.Path, "state", "llm-request-journal.sqlite")
        );
        db.Open();
        using var rows = db.CreateCommand();
        rows.CommandText =
            "SELECT detected_labels||literal_labels||coalesce(failure_kind,'') FROM llm_redaction";
        using var reader = rows.ExecuteReader();
        while (reader.Read())
        {
            Assert.DoesNotContain(Person, reader.GetString(0));
            Assert.DoesNotContain(TextRedactor.Prefix, reader.GetString(0));
        }
    }

    [Theory]
    [InlineData(429, "busy", 6)]
    [InlineData(503, "busy", 6)]
    [InlineData(408, "timeout", 6)]
    [InlineData(500, "service-error", 6)]
    [InlineData(401, "config", 1)]
    [InlineData(413, "too-large", 1)]
    [InlineData(422, "other", 1)]
    public async Task Detection_failures_are_counted_by_kind_but_never_as_attempts(
        int status,
        string kind,
        int failures
    )
    {
        await using var harness = await StartAsync();
        harness.Detector.Intercept = async (context, _) =>
        {
            context.Response.StatusCode = status;
            await context.Response.WriteAsync("failure");
            return true;
        };
        string? requestId = null;
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            new ModelRequestOwner(
                harness.Http,
                new(harness.Provider.BaseUri, "m", "p/m", "", "", 100),
                new(),
                (_, _) => Task.CompletedTask,
                journal: harness.Journal,
                secrets: harness.Keys.Secrets
            ).RequestAsync(
                "s",
                harness.Catalog,
                "p/m",
                null,
                "cache",
                "turn",
                [User("Hello " + Person)],
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                journalRequestStarted: id => requestId = id
            )
        );
        Assert.Equal(failures, error.Final.Attempt);
        Assert.Equal(0, harness.Provider.RequestCount);
        Assert.Empty((await harness.Journal.ReconstructAsync(requestId!))["attempts"]!.AsArray());
        var cell = Assert.Single(harness.Journal.QueryRedaction(Always, "purpose"));
        Assert.Equal("low-level", cell.Key);
        Assert.Equal(0, cell.Attempts);
        Assert.Equal(failures, cell.Failures[kind]);
    }

    [Fact]
    public async Task Connection_and_invalid_responses_have_their_own_failure_kinds()
    {
        await using var harness = await StartAsync();
        harness.Detector.Transform = response =>
        {
            response["offset_unit"] = "chars";
            return response;
        };
        await Assert.ThrowsAsync<ModelRequestException>(() => harness.RequestAsync(User("hi")));
        Assert.Equal(
            1,
            Assert.Single(harness.Journal.QueryRedaction(Always, null)).Failures["invalid-response"]
        );
        var refused = new TextRedactionException(
            "x",
            true,
            kind: TextRedactionFailureKind.Connection
        );
        Assert.Equal("connection", refused.Kind);
        Assert.Equal("too-large", new TextRedactionException("x", false, tooLarge: true).Kind);
    }

    [Fact]
    public async Task Old_journals_without_the_table_keep_loading_and_reporting()
    {
        await using var harness = await StartAsync();
        await harness.RequestAsync(User("Hello " + Person));
        harness.Journal.Dispose();
        var path = Path.Combine(harness.Temp.Path, "state", "llm-request-journal.sqlite");
        using (
            var db = new Microsoft.Data.Sqlite.SqliteConnection(
                "Data Source=" + path + ";Pooling=False"
            )
        )
        {
            db.Open();
            using var drop = db.CreateCommand();
            drop.CommandText = "DROP TABLE llm_redaction";
            drop.ExecuteNonQuery();
        }
        using var reopened = new LlmRequestJournalStore(harness.Temp.Path);
        Assert.Empty(reopened.QueryRedaction(Always, null));
        Assert.Empty(reopened.RedactionSessions(Always[0], Always[1]));
        await reopened.InitializeAsync();
        Assert.Single(reopened.QueryUsage(Always, null));
        Assert.Empty(reopened.QueryRedaction(Always, null));
    }

    [Fact]
    public async Task A_result_commits_when_its_redaction_row_cannot_be_written()
    {
        await using var harness = await StartAsync();
        await harness.RequestAsync(User("Hello " + Person));
        var path = Path.Combine(harness.Temp.Path, "state", "llm-request-journal.sqlite");
        using (
            var db = new Microsoft.Data.Sqlite.SqliteConnection(
                "Data Source=" + path + ";Pooling=False"
            )
        )
        {
            db.Open();
            using var drop = db.CreateCommand();
            drop.CommandText = "DROP TABLE llm_redaction";
            drop.ExecuteNonQuery();
        }
        var result = await harness.RequestAsync(User("Hello again " + Person));
        Assert.NotNull(result.AssistantMessage!["__meta"]!["textRedaction"]);
        Assert.Equal(2, harness.Journal.QueryUsage(Always, null).Sum(cell => cell.Requests));
        Assert.Empty(harness.Journal.QueryRedaction(Always, null));
    }
}
