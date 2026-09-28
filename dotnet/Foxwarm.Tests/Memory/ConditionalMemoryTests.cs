using Foxwarm;

namespace Foxwarm.Tests;

public class ConditionalMemoryTests
{
    [Fact]
    public void Keeps_matching_and_removes_nonmatching_pairs()
    {
        var source = string.Join('\n', "before", "<foxwarm-if model-id=\"provider/astra\">", "exact", "</foxwarm-if>", "<foxwarm-if model-id=\"*-astra\">", "wildcard", "</foxwarm-if>", "<foxwarm-if model-id=\"other/*\">", "removed", "</foxwarm-if>", "after");
        Assert.Equal(string.Join('\n', "before", "exact", "after"), ConditionalMemory.FilterConditionalMemorySource(source, "provider/astra"));
        Assert.Equal(string.Join('\n', "before", "wildcard", "after"), ConditionalMemory.FilterConditionalMemorySource(source, "local-astra"));
    }

    [Fact]
    public void Uses_only_literal_star_as_case_sensitive_whole_value_wildcard()
    {
        var source = "<foxwarm-if model-id=\"A?/*-astra\">\nbody\n</foxwarm-if>\n";
        Assert.Equal("body\n", ConditionalMemory.FilterConditionalMemorySource(source, "A?/x/y-astra"));
        Assert.Equal("", ConditionalMemory.FilterConditionalMemorySource(source, "a?/x/y-astra"));
        Assert.Equal("", ConditionalMemory.FilterConditionalMemorySource(source, "prefix-A?/x/y-astra"));
    }

    [Fact]
    public void Preserves_inline_fenced_malformed_nested_unicode_and_newline_behavior()
    {
        var source = string.Join('\n', "```xml", "<foxwarm-if model-id=\"other\">", "fenced 😀", "</foxwarm-if>", "```", "<foxwarm-if model-id=\"leaf\">", "~~~text", "</foxwarm-if>", "~~~", "kept", "</foxwarm-if>");
        Assert.Equal(string.Join('\n', "```xml", "<foxwarm-if model-id=\"other\">", "fenced 😀", "</foxwarm-if>", "```", "~~~text", "</foxwarm-if>", "~~~", "kept") + "\n", ConditionalMemory.FilterConditionalMemorySource(source, "leaf"));

        var malformed = "<foxwarm-if model-id='leaf'>\ntext\n</foxwarm-if>";
        Assert.Equal(malformed, ConditionalMemory.FilterConditionalMemorySource(malformed, "leaf"));
        var nested = string.Join('\n', "<foxwarm-if model-id=\"leaf\">", "outer", "<foxwarm-if model-id=\"leaf\">", "inner", "</foxwarm-if>", "</foxwarm-if>");
        Assert.Equal(nested, ConditionalMemory.FilterConditionalMemorySource(nested, "leaf"));

        var crlf = "head\r\n<foxwarm-if model-id=\"leaf\">\r\none\r\ntwo\r\n</foxwarm-if>\r\ntail\r\n";
        Assert.Equal("head\r\none\r\ntwo\r\ntail\r\n", ConditionalMemory.FilterConditionalMemorySource(crlf, "leaf"));
    }

    [Fact]
    public void Decodes_attributes_and_round_trips_exact_snapshot_header()
    {
        var source = "<foxwarm-if model-id=\"provider/a&amp;b/*\">\nbody\n</foxwarm-if>";
        Assert.Equal("body\n", ConditionalMemory.FilterConditionalMemorySource(source, "provider/a&b/model"));

        var modelId = "provider/a&<\"'model";
        var body = "line 1\r\nline 2\r\n";
        var snapshot = ConditionalMemory.BuildCurrentModelSnapshot(modelId, body);
        Assert.Equal("<foxwarm-current-model model-id=\"provider/a&amp;&lt;&quot;&apos;model\" />\n\nline 1\r\nline 2\r\n", snapshot);
        Assert.Equal(modelId, ConditionalMemory.ReadCurrentModelSnapshotId(snapshot));
    }

    [Fact]
    public void Reader_requires_exact_first_line_and_separator()
    {
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId("intro\n<foxwarm-current-model model-id=\"provider/astra\" />\n\nbody"));
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId("<foxwarm-current-model model-id=\"provider/astra\" />"));
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId(" <foxwarm-current-model model-id=\"provider/astra\" />\n\nbody"));
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId("<foxwarm-current-model model-id=\"provider/astra\"/>\n\nbody"));
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId("<foxwarm-current-model model-id=\"provider/&bogus;\" />\n\nbody"));
        Assert.Null(ConditionalMemory.ReadCurrentModelSnapshotId("<foxwarm-current-model model-id=\"provider/astra\" />\r\n\r\nbody"));
        Assert.Equal("<foxwarm-current-model model-id=\"provider/astra\" />\n\n", ConditionalMemory.BuildCurrentModelSnapshot("provider/astra", ""));
        Assert.Equal("<foxwarm-current-model model-id=\"provider/astra\" />\n\n\r\nbody", ConditionalMemory.BuildCurrentModelSnapshot("provider/astra", "\r\nbody"));
    }
}
