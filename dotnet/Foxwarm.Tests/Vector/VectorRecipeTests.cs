using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorRecipeTests
{
    private static JsonObject SourceMessage(string id, long seq, JsonObject message) =>
        new()
        {
            ["v"] = 1,
            ["kind"] = "message",
            ["sessionId"] = id,
            ["agent"] = "main",
            ["seq"] = seq,
            ["timestamp"] = seq * 1000,
            ["role"] = message["role"]!.DeepClone(),
            ["message"] = message,
        };

    private static ArchiveMessageRecord Record(string id, long seq, JsonObject message)
    {
        message["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 };
        return ArchiveMessageRecord.Create(id, "main", seq, seq * 1000, message);
    }

    internal static void EqualJson(JsonNode? expected, JsonNode? actual)
    {
        Assert.True(
            JsonNode.DeepEquals(expected, actual),
            "Expected:\n" + expected?.ToJsonString() + "\nActual:\n" + actual?.ToJsonString()
        );
    }

    [Fact]
    public async Task Recipes_query_compilation_configuration_and_raw_windows_match_frozen_Source()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/recipes";
        var messages = new List<JsonObject>
        {
            VectorFixture.Message("violet first\nsecond\r\nthird"),
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["thinking"] = "NEVER_INDEX_THINKING",
                        ["text"] = "visible model text",
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "call-one",
                            ["name"] = "write",
                            ["args"] = new JsonObject { ["10"] = 10, ["2"] = 2 },
                            ["rawArgsText"] = "{broken",
                            ["argsParseError"] = "synthetic parse error",
                        },
                    }
                ),
            },
            new()
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["name"] = "write",
                            ["tool_use_id"] = "call-one",
                            ["response"] = new JsonObject
                            {
                                ["output"] = new string('z', 300),
                                ["error"] = false,
                            },
                        },
                    }
                ),
            },
            new()
            {
                ["role"] = "user",
                ["modelVisible"] = false,
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "NEVER_INDEX_HIDDEN" }),
            },
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] = "<foxwarm-system kind=\"time\">ignored</foxwarm-system>",
                    },
                    new JsonObject
                    {
                        ["system"] =
                            "  <FOXWARM-MESSAGE type=\"channel\">\nreal channel\nsecond line\n</FOXWARM-MESSAGE> ",
                    },
                    new JsonObject { ["system"] = "stable context" },
                    new JsonObject { ["text"] = "--- RELEVANT MEMORY SNIPPETS (RAG) --- ignored" }
                ),
            },
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["inlineDataRef"] = new JsonObject
                        {
                            ["mimeType"] = "image/png",
                            ["imageId"] = "fixture-pixel",
                            ["blobId"] = "not-image-data",
                        },
                    }
                ),
            },
            VectorFixture.Message(string.Concat(Enumerable.Repeat("opaque~", 900))),
            VectorFixture.Message("last short user message"),
        };
        var records = messages.Select((message, index) => Record(id, index + 1, message)).ToArray();
        f.Archive(id).WriteMessages(records);
        var block = f.Block(id, first: 1, last: 3) with
        {
            Summary = "summary with\nline two",
            MemoryFacts = new JsonArray(
                new JsonObject
                {
                    ["kind"] = "decision",
                    ["text"] = "İSTANBUL  ΑΣ ΣΟ\tＦＵＬＬＷＩＤＴＨ",
                    ["context"] = "synthetic\ncontext",
                    ["attributedTo"] = "both",
                },
                new JsonObject
                {
                    ["kind"] = "decision",
                    ["text"] = "İSTANBUL ΑΣ ΣΟ ＦＵＬＬＷＩＤＴＨ",
                    ["attributedTo"] = "user",
                }
            ),
        };
        var queries = new[]
        {
            "FooBar paths/a.ts deadbeef /session index",
            "中文组合测试",
            "\U00020000\U00020001\U00020002",
            "ＦｏｏＢａｒ KELVIN İSTANBUL ΣΟΣ",
            "show \"node-worker\" details",
            "a\" OR x* NEAR(5)",
            "node ID gpu-vm-01",
            "“quotes”\u00a0résumé\u2028météo",
            new string('a', 2005),
        };
        var configs = new JsonArray(
            new JsonObject(),
            new JsonObject { ["vector"] = false, ["legacy"] = "https://legacy.invalid/root/" },
            new JsonObject
            {
                ["legacy"] = "https://legacy.invalid/nested/",
                ["dbWorkers"] = false,
                ["maintenance"] = false,
            },
            new JsonObject
            {
                ["vector"] = new JsonObject
                {
                    ["baseUrl"] = "https://embed.invalid/v1/",
                    ["lexicalIndex"] = true,
                    ["hybridSearch"] = true,
                },
                ["maintenance"] = new JsonObject { ["retentionHours"] = 48 },
            },
            new JsonObject
            {
                ["vector"] = new JsonObject
                {
                    ["enabled"] = false,
                    ["baseUrl"] = "https://embed.invalid/",
                    ["lexicalIndex"] = true,
                },
            }
        );
        var windowRecords = records
            .Take(3)
            .Concat(
                Enumerable
                    .Range(4, 12)
                    .Select(seq =>
                        Record(
                            id,
                            seq,
                            VectorFixture.Message(
                                seq == 8 ? "needle positive match" : "surrounding user context"
                            )
                        )
                    )
            )
            .ToArray();
        var windows = new JsonArray();
        foreach (
            var (query, chunk, filters) in new[]
            {
                ("violet", "visible model text", new JsonObject()),
                ("needle", "", new JsonObject { ["contentFilter"] = "positive" }),
                ("nonexistent", "", new JsonObject()),
                ("opaque", "", new JsonObject { ["includeRegex"] = "violet|positive" }),
            }
        )
            windows.Add(
                new JsonObject
                {
                    ["query"] = query,
                    ["chunk"] = chunk,
                    ["filters"] = filters,
                    ["records"] = new JsonArray(
                        windowRecords
                            .Select(record =>
                                (JsonNode?)SourceMessage(
                                    record.SessionId,
                                    record.Seq,
                                    (JsonObject)record.Message.DeepClone()
                                )
                            )
                            .ToArray()
                    ),
                }
            );
        var input = new JsonObject
        {
            ["records"] = new JsonArray(
                records
                    .Select(record =>
                        (JsonNode?)SourceMessage(
                            id,
                            record.Seq,
                            (JsonObject)record.Message.DeepClone()
                        )
                    )
                    .ToArray()
            ),
            ["blocks"] = JsonSerializer.SerializeToNode(new[] { block }, VectorWire.Json),
            ["queries"] = new JsonArray(
                queries.Select(query => (JsonNode?)JsonValue.Create(query)).ToArray()
            ),
            ["configs"] = configs,
            ["windows"] = windows,
            ["utf16Samples"] = new JsonArray(
                new JsonArray(0xd800, 0x41, 0xdc00, 0xd83e, 0xdd8a, 0)
            ),
        };
        var inputPath = Path.Combine(f.Temp.Path, "input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var source = await VectorFixture.SourceAsync(
            "recipes",
            Path.Combine(f.Temp.Path, "source"),
            inputPath,
            Path.Combine(f.Temp.Path, "source.json")
        );
        var malformed = new string(
            new[] { (char)0xd800, 'A', (char)0xdc00, (char)0xd83e, (char)0xdd8a, (char)0 }
        );
        var sanitized = source["sanitized"]![0]!.GetValue<string>();
        Assert.Equal(sanitized, VectorText.WellFormed(malformed));
        await using (var embedding = new VectorRuntime(f.Data, f.Configuration()))
            await embedding.EmbeddingAsync(malformed);
        Assert.Equal(sanitized, Assert.Single(f.Peer.Requests).Input);
        EqualJson(
            source["formatted"],
            new JsonArray(
                records
                    .Select(record =>
                        (JsonNode?)JsonValue.Create(VectorText.Message(record.Message))
                    )
                    .ToArray()
            )
        );
        var rows = VectorRows
            .Segments(records)
            .SelectMany(VectorRows.Raw)
            .Select(row => (JsonNode?)row)
            .ToArray();
        EqualJson(source["rows"], new JsonArray(rows));
        EqualJson(source["blocks"], new JsonArray(VectorRows.Block(block, f.Archive(id))));
        EqualJson(
            source["facts"],
            new JsonArray(VectorRows.Facts(block).Select(row => (JsonNode?)row).ToArray())
        );
        for (var index = 0; index < queries.Length; index++)
        {
            Assert.Equal(
                source["fts"]![index]!["text"]!.GetValue<string>(),
                ArchiveSearchText.IndexText(queries[index])
            );
            EqualJson(
                source["fts"]![index]!["compiled"],
                JsonSerializer.SerializeToNode(
                    ArchiveSearchText.Compile(queries[index]),
                    VectorWire.Json
                )
            );
            EqualJson(
                source["fts"]![index]!["locators"],
                JsonSerializer.SerializeToNode(
                    ArchiveLexicalRecall.Locators(queries[index]),
                    VectorWire.Json
                )
            );
        }
        for (var index = 0; index < configs.Count; index++)
        {
            var entry = configs[index]!.AsObject();
            var app = new JsonObject();
            if (entry.ContainsKey("vector"))
                app["vector"] = entry["vector"]?.DeepClone();
            if (entry.ContainsKey("legacy"))
                app["llm"] = new JsonObject { ["ollamaBaseUrl"] = entry["legacy"]!.DeepClone() };
            if (entry.ContainsKey("dbWorkers"))
                app["dbWorkers"] = entry["dbWorkers"]!.DeepClone();
            if (entry.ContainsKey("maintenance"))
                app["vectorMaintenance"] = entry["maintenance"]!.DeepClone();
            var actual = VectorConfiguration.Capture(app);
            var expected = source["configs"]![index]!;
            Assert.Equal(expected["vector"]!["enabled"]!.GetValue<bool>(), actual.Enabled);
            Assert.Equal(SessionWait.Text(expected["vector"]!["baseUrl"]), actual.BaseUrl);
            Assert.Equal(
                expected["vector"]!["lexicalIndex"]!.GetValue<bool>(),
                actual.LexicalIndex
            );
            Assert.Equal(
                expected["vector"]!["hybridSearch"]!.GetValue<bool>(),
                actual.HybridSearch
            );
            Assert.Equal(expected["vector"]!["source"]!.GetValue<string>(), actual.Source);
            Assert.Equal(expected["workers"]!.GetValue<bool>(), actual.DbWorkers);
            Assert.Equal(
                expected["maintenance"]!["enabled"]!.GetValue<bool>(),
                actual.MaintenanceEnabled
            );
            Assert.Equal(
                expected["maintenance"]!["retentionHours"]!.GetValue<double>(),
                actual.RetentionHours
            );
        }
        for (var index = 0; index < windows.Count; index++)
        {
            var window = windows[index]!;
            var actual = VectorRawWindow.Select(
                windowRecords,
                window["query"]!.GetValue<string>(),
                window["chunk"]!.GetValue<string>(),
                window["filters"]!.AsObject()
            );
            var expected = source["windows"]![index]!;
            EqualJson(
                expected["sequences"],
                new JsonArray(
                    actual
                        .Records.Select(record => (JsonNode?)JsonValue.Create(record.Seq))
                        .ToArray()
                )
            );
            Assert.Equal(expected["omitted"]!.GetValue<int>(), actual.OmittedCount);
            EqualJson(
                expected["notices"],
                new JsonArray(
                    actual.Notices.Select(notice => (JsonNode?)JsonValue.Create(notice)).ToArray()
                )
            );
        }
    }
}
