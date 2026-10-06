using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.ToolScript;
using Google.Protobuf;
using Monty.V1;

namespace Foxwarm.Tests.ToolScript;

public sealed class ToolScriptBudgetTests
{
    [Fact]
    public void Repeated_none_budget_rejects_before_generated_parse_and_allows_ordinary_values()
    {
        var values = new ObjectList();
        for (var index = 0; index < 10000; index++)
            values.Items.Add(new MontyObject { None = new Unit() });
        var frame = new ChildEvent
        {
            Complete = new Complete { Value = new MontyObject { List = values } },
        }.ToByteArray();
        Assert.Throws<ToolScriptDataLimitException>(() =>
            MontyFrameBudget.Preflight(frame, new(16 * 1024))
        );
        var budget = new ToolScriptDataBudget();
        var parsed = MontyFrameBudget.Parse(frame, budget);
        Assert.Equal(10000, parsed.Complete.Value.List.Items.Count);
        Assert.True(budget.Used > 902872); // Measured generated parse allocation, before semantic JSON conversion.
    }

    [Fact]
    public void Native_legal_value_boundary_and_control_bytes_pass_without_lowering_frame_cap()
    {
        var value = new MontyObject { None = new Unit() };
        for (var index = 0; index < 48; index++)
            value = new MontyObject { List = new ObjectList { Items = { value } } };
        var frame = new ChildEvent { Complete = new Complete { Value = value } }.ToByteArray();
        Assert.NotNull(MontyFrameBudget.Parse(frame, new()).Complete);
        var text = new ChildEvent { Print = new Print { Text = "unicode 🦊\n" } }.ToByteArray();
        Assert.Equal("unicode 🦊\n", MontyFrameBudget.Parse(text, new()).Print.Text);
        var snapshot = new ChildEvent
        {
            DumpResult = new DumpResult { State = ByteString.CopyFrom(new byte[65536]) },
        }.ToByteArray();
        Assert.Equal(65536, MontyFrameBudget.Parse(snapshot, new()).DumpResult.State.Length);
        Assert.Throws<ToolScriptDataLimitException>(() =>
            MontyFrameBudget.Parse(snapshot, new(128 * 1024))
        );
    }

    [Fact]
    public void Malformed_submessage_boundaries_reject_and_unknown_fields_are_not_materialized()
    {
        Assert.ThrowsAny<System.Exception>(() => MontyFrameBudget.Preflight([10, 5, 8, 1], new()));
        var frame = new ChildEvent { Ok = new Ok() }.ToByteArray();
        using var bytes = new MemoryStream();
        bytes.Write(frame);
        using (var writer = new CodedOutputStream(bytes, leaveOpen: true))
        {
            writer.WriteTag(1000, WireFormat.WireType.LengthDelimited);
            writer.WriteString("unknown");
            writer.Flush();
        }
        var parsed = MontyFrameBudget.Parse(bytes.ToArray(), new());
        Assert.Equal(frame, parsed.ToByteArray());
    }

    [Fact]
    public void Cumulative_stdout_actual_64MiB_boundary_fails_without_cutting_unicode_or_claiming_completion()
    {
        var stdout = new ToolScriptStdout();
        var chunk = new string('a', 1024 * 1024);
        for (var slice = 0; slice < 64; slice++)
            stdout.Append(chunk);
        Assert.Equal(ToolScriptStdout.Limit, stdout.Bytes);
        Assert.Throws<ToolScriptOutputLimitException>(() => stdout.Append("🦊"));
        Assert.Equal(ToolScriptStdout.Limit, stdout.Bytes);
        var unicode = new ToolScriptStdout("old 🦊");
        var offset = unicode.Count;
        unicode.Append("é\n");
        Assert.Equal("é\n", unicode.Delta(offset));
        Assert.Equal(Encoding.UTF8.GetByteCount("old 🦊é\n"), unicode.Bytes);
        var ordinary = new ToolScriptStdout();
        for (var index = 0; index < 4; index++)
            ordinary.Append(chunk);
        Assert.Equal(4 * 1024 * 1024, ordinary.Text().Length);
    }

    [Fact]
    public async Task Record_budget_refuses_before_materialization_and_never_changes_large_old_file()
    {
        using var directory = new TempDirectory();
        var path = Path.Combine(directory.Path, "record.json");
        await File.WriteAllTextAsync(
            path,
            new JsonObject
            {
                ["ownerSessionId"] = "old/main",
                ["stdout"] = new string('a', 1024 * 1024),
            }.ToJsonString()
        );
        var original = new FileInfo(path).Length;
        await Assert.ThrowsAsync<ToolScriptDataLimitException>(() =>
            new ToolScriptDataBudget(2 * 1024 * 1024).ReadRecordAsync(path, default)
        );
        Assert.Equal(original, new FileInfo(path).Length);
        var record = await new ToolScriptDataBudget().ReadRecordAsync(path, default);
        Assert.Equal("old/main", record["ownerSessionId"]!.GetValue<string>());
        await using (var sparse = new FileStream(path, FileMode.Create))
            sparse.SetLength(ToolScriptDataBudget.DefaultLimit + 1);
        await Assert.ThrowsAsync<ToolScriptDataLimitException>(() =>
            new ToolScriptDataBudget().ReadRecordAsync(path, default)
        );
        Assert.Equal(ToolScriptDataBudget.DefaultLimit + 1, new FileInfo(path).Length);
    }

    [Fact]
    public void Opaque_json_values_are_budgeted_before_copy_including_streaming_multi_block_strings()
    {
        var node = JsonNode.Parse(
            "{\"value\":\""
                + new string('x', 100000)
                + "\",\"flag\":false,\"zero\":0,\"nothing\":null}"
        )!;
        Assert.Throws<ToolScriptDataLimitException>(() =>
            new ToolScriptDataBudget(1024).JsonValue(node)
        );
        var budget = new ToolScriptDataBudget();
        budget.JsonValue(node);
        Assert.True(budget.Used >= 800000);
    }
}
