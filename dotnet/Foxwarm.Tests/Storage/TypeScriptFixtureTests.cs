using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class TypeScriptFixtureTests
{
    [Fact]
    public void ActualTypeScriptFixtureReadsRewritesAndReadsWithoutChangingRawArchivePayloads()
    {
        using var temp = new TempDirectory();
        var firstResult = Path.Combine(temp.Path, "ts-write-result.json");
        TypeScriptOracle.Run("write-ts", temp.Path, firstResult);
        var before = JsonNode.Parse(File.ReadAllText(firstResult))!.AsObject();
        var authorityPath = Path.Combine(temp.Path, "state", "sessions", "c1", "fixture.json");
        var document = SessionAuthorityDocument.Load(authorityPath, Fixture.SessionId);
        var archive = new SqliteArchiveMessageStore(Path.Combine(temp.Path, "state", "archive-store.sqlite"), Fixture.SessionId);
        archive.Initialize();
        var readRecords = archive.ReadMessages();
        Assert.Equal([1L, 2L, 3L, 4L], readRecords.Select(record => record.Seq));
        Assert.Empty(archive.WriteMessages(readRecords));

        var writer = new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json");
        writer.Write(document);
        var secondResult = Path.Combine(temp.Path, "ts-read-result.json");
        TypeScriptOracle.Run("read", temp.Path, secondResult);
        var after = JsonNode.Parse(File.ReadAllText(secondResult))!.AsObject();
        Assert.True(JsonNode.DeepEquals(before["authority"], after["authority"]));
        Assert.Equal(RawMessageJson(before), RawMessageJson(after));
    }

    [Fact]
    public void CsharpFixtureIsAcceptedByActualTypeScriptReadersAndPreservesUnknownJson()
    {
        using var temp = new TempDirectory();
        var messages = StressMessages();
        var root = PersistencePrimitiveTests.FixtureAuthority(messages);
        root["futureTopLevel"] = new JsonObject { ["10"] = "ten", ["2"] = "two", ["retained"] = true };
        root["queue"] = new JsonArray(new JsonObject
        {
            ["type"] = "intersession",
            ["sourceSessionId"] = "parent",
            ["sourceSessionRelation"] = "parent",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "queued", ["futurePart"] = 1 }),
            ["source"] = new JsonObject
            {
                ["platform"] = "webui",
                ["channelUserId"] = "conversation",
                ["futureSource"] = new JsonObject { ["keep"] = true }
            },
            ["futureQueue"] = new JsonObject { ["keep"] = true }
        });
        var document = SessionAuthorityDocument.FromOwned(root, Fixture.SessionId);
        var archive = new SqliteArchiveMessageStore(Path.Combine(temp.Path, "state", "archive-store.sqlite"), Fixture.SessionId);
        archive.Initialize();
        var records = messages.Select((message, index) => ArchiveMessageRecord.Create(
            Fixture.SessionId, "main", index + 1, (index + 1) * 1000, message)).ToArray();
        Assert.Equal(4, archive.WriteMessages(records).Count);
        new LinuxAtomicJsonFile(temp.Path, "state/sessions/c1/fixture.json").Write(document);

        Assert.Equal(["archive_blocks", "archive_branches", "archive_messages", "archive_session_id_reservations"], UserTableNames(Path.Combine(temp.Path, "state", "archive-store.sqlite")));
        var replayPath = Path.Combine(temp.Path, "ts-replay-result.json");
        TypeScriptOracle.Run("replay-ts", temp.Path, replayPath);
        Assert.Equal(0, JsonNode.Parse(File.ReadAllText(replayPath))!["insertedCount"]!.GetValue<int>());
        var resultPath = Path.Combine(temp.Path, "ts-read-result.json");
        TypeScriptOracle.Run("read", temp.Path, resultPath);
        var result = JsonNode.Parse(File.ReadAllText(resultPath))!.AsObject();
        Assert.True(JsonNode.DeepEquals(root, result["authority"]));
        Assert.Equal(records.Select(record => record.MessageJson), RawMessageJson(result));
        Assert.Contains("archive_branches", UserTableNames(Path.Combine(temp.Path, "state", "archive-store.sqlite")));
    }

    [Fact]
    public void EcmaNumberMatchesActualJavaScriptForBoundariesAndSeededFiniteBinary64Sample()
    {
        using var temp = new TempDirectory();
        var values = new List<double>
        {
            -0.0, 0.0, 1e-7, 1e-6, Math.BitDecrement(1e-6), Math.BitIncrement(1e-6),
            1e20, Math.BitDecrement(1e20), Math.BitIncrement(1e20),
            1e21, Math.BitDecrement(1e21), Math.BitIncrement(1e21),
            12.5, 1987.5, 0.1, double.Epsilon, double.MaxValue, double.MinValue
        };
        var random = new Random(20260922);
        var randomBytes = new byte[8];
        while (values.Count < 530)
        {
            random.NextBytes(randomBytes);
            var value = BitConverter.Int64BitsToDouble(BitConverter.ToInt64(randomBytes));
            if (double.IsFinite(value)) values.Add(value);
        }
        var bits = values.Select(value => unchecked((ulong)BitConverter.DoubleToInt64Bits(value)).ToString("x16")).ToArray();
        var inputPath = Path.Combine(temp.Path, "number-bits.json");
        var resultPath = Path.Combine(temp.Path, "number-results.json");
        File.WriteAllText(inputPath, JsonSerializer.Serialize(bits));
        TypeScriptOracle.Run("number-stringify", temp.Path, resultPath, inputPath);
        var actual = JsonNode.Parse(File.ReadAllText(resultPath))!.AsArray().Select(node => node!.GetValue<string>()).ToArray();
        var expected = values.Select(EcmaNumber.Format).ToArray();
        Assert.Equal(actual, expected);
    }

    [Fact]
    public void SupportedCompactJsonExactlyMatchesActualJsonStringifyStressCorpus()
    {
        using var temp = new TempDirectory();
        var values = new JsonArray(StressMessages().Select(message => (JsonNode)message.DeepClone()).ToArray());
        var inputPath = Path.Combine(temp.Path, "stringify-input.json");
        var resultPath = Path.Combine(temp.Path, "stringify-result.json");
        File.WriteAllText(inputPath, values.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        TypeScriptOracle.Run("stringify", temp.Path, resultPath, inputPath);
        var actual = JsonNode.Parse(File.ReadAllText(resultPath))!.AsArray().Select(node => node!.GetValue<string>()).ToArray();
        var expected = StressMessages().Select(EcmaJson.Stringify).ToArray();
        Assert.Equal(actual, expected);
    }

    private static JsonObject[] StressMessages()
    {
        JsonObject NumericOpaque() => new() { ["10"] = "ten", ["2"] = "two", ["a"] = "aye" };
        return
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject
                {
                    ["text"] = "héllo\u2028separator\u2029 quote:\" slash:\\ literal:\\u2028 control:\u0001",
                    ["opaque"] = NumericOpaque(),
                    ["numbers"] = new JsonObject
                    {
                        ["negativeZero"] = -0.0,
                        ["smallScientific"] = 1e-7,
                        ["fixedThreshold"] = 1e-6,
                        ["belowFixedThreshold"] = Math.BitDecrement(1e-6),
                        ["aboveFixedThreshold"] = Math.BitIncrement(1e-6),
                        ["largeFixed"] = 1e20,
                        ["largeScientific"] = 1e21,
                        ["belowScientificThreshold"] = Math.BitDecrement(1e21),
                        ["aboveScientificThreshold"] = Math.BitIncrement(1e21)
                    }
                }),
                ["__meta"] = new JsonObject { ["timestamp"] = 1000, ["seq"] = 1, ["fractionalTiming"] = 12.5 },
                ["futureMessage"] = new JsonObject { ["preserve"] = "yes" }
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "call-1", ["name"] = "write_fixture",
                        ["args"] = new JsonObject
                        {
                            ["fileName"] = "fixture.txt", ["content"] = "héllo",
                            ["opaque"] = NumericOpaque(), ["fraction"] = 12.5
                        },
                        ["rawArgsText"] = "{\"fileName\":\"fixture.txt\",\"content\":\"héllo\"}"
                    },
                    ["providerMeta"] = new JsonObject { ["future"] = NumericOpaque() }
                }),
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = 2000, ["seq"] = 2,
                    ["llmRequestTiming"] = new JsonObject { ["startedAt"] = 1987.5, ["completedAt"] = 2000, ["durationMs"] = 12.5 }
                }
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "call-1", ["name"] = "write_fixture",
                        ["response"] = new JsonObject { ["output"] = "created", ["opaque"] = NumericOpaque() }
                    }
                }),
                ["__meta"] = new JsonObject { ["timestamp"] = 3000, ["seq"] = 3 }
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "final café\u2028\u2029" }),
                ["providerMeta"] = new JsonObject
                {
                    ["providerSpecificFields"] = new JsonObject { ["10"] = "ten", ["2"] = "two", ["signature"] = "sig\\\"" },
                    ["sourceModelId"] = "openai/test"
                },
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = 4000, ["seq"] = 4, ["modelId"] = "openai/test",
                    ["usage"] = new JsonObject { ["inputTokens"] = 1.5, ["outputTokens"] = 2 }
                }
            }
        ];
    }

    private static string[] RawMessageJson(JsonObject result) =>
        result["rawRows"]!.AsArray().Select(row => row!["message_json"]!.GetValue<string>()).ToArray();

    private static string[] UserTableNames(string databasePath)
    {
        using var connection = new SqliteConnection($"Data Source={databasePath};Mode=ReadOnly");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        using var reader = command.ExecuteReader();
        var result = new List<string>();
        while (reader.Read()) result.Add(reader.GetString(0));
        return result.ToArray();
    }
}

internal static class TypeScriptOracle
{
    public static void Run(string mode, string dataRoot, string resultPath, string? inputPath = null)
    {
        var repositoryRoot = FindRepositoryRoot();
        var oracleRoot = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT") ?? repositoryRoot;
        var helper = Path.Combine(repositoryRoot, "dotnet", "session-persistence-fixture-ts.mjs");
        var info = new ProcessStartInfo("node")
        {
            WorkingDirectory = repositoryRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        info.ArgumentList.Add(helper);
        info.ArgumentList.Add(mode);
        info.ArgumentList.Add(dataRoot);
        info.ArgumentList.Add(resultPath);
        if (inputPath is not null) info.ArgumentList.Add(inputPath);
        info.Environment["FOXWARM_TS_ROOT"] = oracleRoot;
        info.Environment["FOXWARM_DATA_DIR"] = dataRoot;
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Unable to start TypeScript fixture oracle.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("TypeScript fixture oracle timed out.");
        }
        Task.WaitAll(stdout, stderr);
        File.WriteAllText(Path.Combine(dataRoot, $"oracle-{mode}.log"), $"stdout:\n{stdout.Result}\nstderr:\n{stderr.Result}");
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"TypeScript fixture oracle failed ({process.ExitCode}): {stderr.Result}");
        if (!File.Exists(resultPath)) throw new InvalidOperationException("TypeScript fixture oracle produced no result file.");
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "dotnet", "session-persistence-fixture-ts.mjs"))
                && File.Exists(Path.Combine(current.FullName, "lib", "session", "archive.js")))
                return current.FullName;
            current = current.Parent;
        }
        throw new DirectoryNotFoundException("Unable to locate the Foxwarm repository root for the TypeScript fixture oracle.");
    }
}
