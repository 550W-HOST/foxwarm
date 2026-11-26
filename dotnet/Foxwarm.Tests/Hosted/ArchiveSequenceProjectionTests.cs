using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The insert-time sequence projection of the PostgreSQL Archive equals what the SQLite
/// sequence reader computes inside SQLite, over rows that exercise each extracted field and
/// SQLite's value conversions.
/// </summary>
public sealed class ArchiveSequenceProjectionTests
{
    private static readonly string Long = string.Concat(Enumerable.Repeat("ab🦊c", 120));

    private static readonly (string Role, string Json)[] Rows =
    [
        ("user", """{"role":"user","parts":[{"text":"hello"},{"system":"sys one"},{"text":"world"},{"system":7}],"modelVisible":true,"__meta":{"timestamp":1}}"""),
        ("user", "{\"role\":\"user\",\"parts\":[{\"text\":\"" + Long + "\"},{\"system\":\"" + Long + Long + Long + Long + Long + Long + "\"}],\"__meta\":{\"timestamp\":2}}"),
        ("user", """{"role":"user","parts":[{"inlineData":{"mimeType":"image/png"}}],"__meta":{"timestamp":3}}"""),
        ("model", """{"role":"model","parts":[{"thinking":"hidden","text":"thought"},{"text":"first ","phase":"commentary"},{"text":"second"},{"text":"third","phase":"final_answer"}],"modelVisible":false,"__meta":{"timestamp":4,"llmRequestTiming":{"startedAt":1.50,"completedAt":2,"flag":true},"noticeType":"retry"}}"""),
        ("model", """{"role":"model","parts":[{"text":"x","phase":"commentary"},{"text":"y"}],"__meta":{"timestamp":5,"noticeType":true}}"""),
        ("model", """{"role":"model","parts":[{"thinking":"only"}],"__meta":{"timestamp":6}}"""),
        ("model", "{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"c1\",\"name\":\"send_to_session\",\"args\":{\"sessionId\":\"" + Long + "\",\"message\":\"" + Long + "\",\"action\":5,\"title\":null,\"args\":{\"command\":\"inner\",\"code\":true}}}},{\"functionCall\":{\"id\":\"c2\",\"name\":\"ctl\",\"args\":{\"command\":\"session view x\",\"values\":{\"a\":1.50,\"b\":\"\\u00e9\",\"c\":[true,null]},\"valuesJson\":\"{}\"}}},{\"functionCall\":{\"id\":\"c3\",\"name\":\"ctl\",\"args\":{\"command\":7,\"values\":{\"big\":\"" + new string('v', 8200) + "\"}}}},{\"functionCall\":{\"id\":\"c4\",\"name\":\"ctl\",\"args\":{\"values\":[1]}}},{\"functionCall\":{\"id\":true,\"name\":\"exec\",\"args\":{\"args\":\"text\"}}}],\"__meta\":{\"timestamp\":7,\"llmRequestTiming\":5.25}}"),
        ("tool", """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"c1","name":"send_to_session","response":{"ok":true},"executionTiming":{"startedAt":10,"durationMs":0.5},"__meta":{"sessionMessages":[{"targetSessionId":"t1","deliverySeq":3,"message":"hi"},{"targetSessionId":"t2","deliverySeq":2.5},null,4]}}}],"__meta":{"timestamp":8}}"""),
        ("tool", """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"c2","name":"x","response":{"error":{"type":"bad"},"code":"E_CODE","canceled":true},"__meta":{"sessionMessages":{"first":{"targetSessionId":"o1"},"second":{"deliverySeq":9}},"toolScriptSubCalls":[{"name":"exec","status":"ok","startedAt":12,"durationMs":0.1234567890123456789,"sessionMessage":{"targetSessionId":"s","deliverySeq":1,"message":"sub"}},{"name":"read","durationMs":1e3,"startedAt":12.0}]}}},{"functionResponse":{"tool_use_id":"c3","name":"y","response":{"error":"plain","code":null,"canceled":false}}},{"functionResponse":{"tool_use_id":"c4","name":"z","response":{"error":null}}},{"functionResponse":{"tool_use_id":"c5","name":"w","response":{"error":{"type":"typed"}},"__meta":{"sessionMessages":null}}}],"__meta":{"timestamp":9}}"""),
        ("tool", """{"role":"tool","parts":[{"text":"not a response"}],"__meta":{"timestamp":10}}"""),
    ];

    [Fact]
    public void Insert_time_projection_matches_the_SQLite_sequence_reader()
    {
        using var temp = new TempDirectory();
        var archive = new SqliteArchiveStore(temp.Path);
        new SqliteArchiveMessageStore(archive.DatabasePath, "s").Initialize();
        using (
            var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = archive.DatabasePath, Pooling = false }.ToString()
            )
        )
        {
            connection.Open();
            using var insert = connection.CreateCommand();
            insert.CommandText =
                "INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES('s','main',$seq,$seq,$role,$json)";
            var seq = insert.Parameters.Add("$seq", SqliteType.Integer);
            var role = insert.Parameters.Add("$role", SqliteType.Text);
            var json = insert.Parameters.Add("$json", SqliteType.Text);
            for (var index = 0; index < Rows.Length; index++)
            {
                seq.Value = index + 1;
                role.Value = Rows[index].Role;
                json.Value = Rows[index].Json;
                insert.ExecuteNonQuery();
            }
        }
        using var reader = archive.OpenSequenceReader()!;
        var page = reader.ReadRange("s", new ArchiveSpan("s", 1, 1, Rows.Length, Rows.Length), 1, Rows.Length);
        Assert.Equal(Rows.Length, page.Rows.Count);
        for (var index = 0; index < Rows.Length; index++)
        {
            var projected = JsonNode.Parse(ArchiveSequenceProjection.Project(Rows[index].Role, Rows[index].Json))!;
            Assert.Equal(Canonical(page.Rows[index].Data), Canonical(projected));
        }
    }

    /// <summary>Order-preserving text of a JSON value with every number as its double value.</summary>
    internal static string Canonical(JsonNode? node) => Normalize(node)?.ToJsonString() ?? "null";

    private static JsonNode? Normalize(JsonNode? node) =>
        node switch
        {
            null => null,
            JsonObject obj => new JsonObject(obj.Select(pair => KeyValuePair.Create(pair.Key, Normalize(pair.Value)))),
            JsonArray array => new JsonArray(array.Select(Normalize).ToArray()),
            JsonValue value when value.GetValueKind() == JsonValueKind.Number => JsonValue.Create(
                double.Parse(value.ToJsonString(), CultureInfo.InvariantCulture)
            ),
            _ => node.DeepClone(),
        };
}
