using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class JavaScriptJsonParityTests
{
    [Fact]
    public void EcmaNumberMatchesActualJavaScriptForBoundariesAndSeededFiniteBinary64Sample()
    {
        using var temp = new TempDirectory();
        var values = new List<double>
        {
            -0.0,
            0.0,
            1e-7,
            1e-6,
            Math.BitDecrement(1e-6),
            Math.BitIncrement(1e-6),
            1e20,
            Math.BitDecrement(1e20),
            Math.BitIncrement(1e20),
            1e21,
            Math.BitDecrement(1e21),
            Math.BitIncrement(1e21),
            12.5,
            1987.5,
            0.1,
            double.Epsilon,
            double.MaxValue,
            double.MinValue,
        };
        var random = new Random(20260922);
        var randomBytes = new byte[8];
        while (values.Count < 530)
        {
            random.NextBytes(randomBytes);
            var value = BitConverter.Int64BitsToDouble(BitConverter.ToInt64(randomBytes));
            if (double.IsFinite(value))
                values.Add(value);
        }
        var bits = values
            .Select(value =>
                unchecked((ulong)BitConverter.DoubleToInt64Bits(value)).ToString("x16")
            )
            .ToArray();
        var inputPath = Path.Combine(temp.Path, "number-bits.json");
        var resultPath = Path.Combine(temp.Path, "number-results.json");
        File.WriteAllText(inputPath, JsonSerializer.Serialize(bits));
        JavaScriptJsonOracle.Run("number-stringify", inputPath, resultPath);
        var actual = JsonNode
            .Parse(File.ReadAllText(resultPath))!
            .AsArray()
            .Select(node => node!.GetValue<string>())
            .ToArray();
        var expected = values.Select(EcmaNumber.Format).ToArray();
        Assert.Equal(actual, expected);
    }

    [Fact]
    public void SupportedCompactJsonExactlyMatchesActualJsonStringifyStressCorpus()
    {
        using var temp = new TempDirectory();
        var values = new JsonArray(
            StressMessages().Select(message => (JsonNode)message.DeepClone()).ToArray()
        );
        var inputPath = Path.Combine(temp.Path, "stringify-input.json");
        var resultPath = Path.Combine(temp.Path, "stringify-result.json");
        File.WriteAllText(
            inputPath,
            values.ToJsonString(new JsonSerializerOptions { WriteIndented = false })
        );
        JavaScriptJsonOracle.Run("stringify", inputPath, resultPath);
        var actual = JsonNode
            .Parse(File.ReadAllText(resultPath))!
            .AsArray()
            .Select(node => node!.GetValue<string>())
            .ToArray();
        var expected = StressMessages().Select(EcmaJson.Stringify).ToArray();
        Assert.Equal(actual, expected);
    }

    private static JsonObject[] StressMessages()
    {
        JsonObject NumericOpaque() =>
            new()
            {
                ["10"] = "ten",
                ["2"] = "two",
                ["a"] = "aye",
            };
        return
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["text"] =
                            "héllo\u2028separator\u2029 quote:\" slash:\\ literal:\\u2028 control:\u0001",
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
                            ["aboveScientificThreshold"] = Math.BitIncrement(1e21),
                        },
                    }
                ),
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = 1000,
                    ["seq"] = 1,
                    ["fractionalTiming"] = 12.5,
                },
                ["futureMessage"] = new JsonObject { ["preserve"] = "yes" },
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "call-1",
                            ["name"] = "write_fixture",
                            ["args"] = new JsonObject
                            {
                                ["fileName"] = "fixture.txt",
                                ["content"] = "héllo",
                                ["opaque"] = NumericOpaque(),
                                ["fraction"] = 12.5,
                            },
                            ["rawArgsText"] =
                                "{\"fileName\":\"fixture.txt\",\"content\":\"héllo\"}",
                        },
                        ["providerMeta"] = new JsonObject { ["future"] = NumericOpaque() },
                    }
                ),
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = 2000,
                    ["seq"] = 2,
                    ["llmRequestTiming"] = new JsonObject
                    {
                        ["startedAt"] = 1987.5,
                        ["completedAt"] = 2000,
                        ["durationMs"] = 12.5,
                    },
                },
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "call-1",
                            ["name"] = "write_fixture",
                            ["response"] = new JsonObject
                            {
                                ["output"] = "created",
                                ["opaque"] = NumericOpaque(),
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = 3000, ["seq"] = 3 },
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "final café\u2028\u2029" }),
                ["providerMeta"] = new JsonObject
                {
                    ["providerSpecificFields"] = new JsonObject
                    {
                        ["10"] = "ten",
                        ["2"] = "two",
                        ["signature"] = "sig\\\"",
                    },
                    ["sourceModelId"] = "openai/test",
                },
                ["__meta"] = new JsonObject
                {
                    ["timestamp"] = 4000,
                    ["seq"] = 4,
                    ["modelId"] = "openai/test",
                    ["usage"] = new JsonObject { ["inputTokens"] = 1.5, ["outputTokens"] = 2 },
                },
            },
        ];
    }
}

internal static class JavaScriptJsonOracle
{
    public static void Run(string mode, string inputPath, string resultPath)
    {
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        info.ArgumentList.Add(
            Path.Combine(
                VectorFixture.Repository(),
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "json-stringify-oracle.mjs"
            )
        );
        info.ArgumentList.Add(mode);
        info.ArgumentList.Add(inputPath);
        info.ArgumentList.Add(resultPath);
        using var process =
            Process.Start(info)
            ?? throw new InvalidOperationException("Unable to start the JSON.stringify oracle.");
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("JSON.stringify oracle timed out.");
        }
        Task.WaitAll(stdout, stderr);
        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"JSON.stringify oracle failed ({process.ExitCode}): {stderr.Result}"
            );
    }
}
