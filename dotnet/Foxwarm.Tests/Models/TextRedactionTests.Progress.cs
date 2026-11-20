using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    // Drafts show raw, possibly incomplete argument text. Restoration must keep it growing,
    // as without redaction, and keep it the same JSON fragment.
    [Fact]
    public async Task Draft_arguments_restore_raw_partial_json_and_hold_an_unfinished_placeholder()
    {
        const string secret = "Ada \"Quoted\" \\path\n\t\u0001私😀</b>";
        await using var detector = await TextDetectionPeer.StartAsync(secret);
        using var http = ProviderHttpRequest.CreateClient();
        var settings = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var scope = new TextRedactor(Key).Begin(http, settings, default);
        var key = await scope.RedactAsync(secret);
        Assert.StartsWith(TextRedactor.Prefix, key);
        var unknown = TextRedactor.Prefix + new string('0', 16) + "]]";
        var escaped = TextRedactionProjection.JsonStringContent(secret);
        // Only required escapes; non-ASCII, emoji and HTML characters stay literal.
        Assert.Equal("Ada \\\"Quoted\\\" \\\\path\\n\\t\\u0001私😀</b>", escaped);
        Assert.Equal(secret, JsonNode.Parse("\"" + escaped + "\"")!.GetValue<string>());

        string? Draft(string? raw) =>
            TextRedactionProjection
                .RestoreProgress(
                    new ResponsesStreamProgress(
                        "",
                        "",
                        [new ResponsesToolCallProgress(0, "c", "echo", raw)]
                    ),
                    scope
                )
                .ToolCalls[0]
                .Arguments;

        Assert.Null(Draft(null));
        const string head = "{ \"value\": \"to ";
        // An incomplete object still shows everything before the unfinished placeholder.
        Assert.Equal("{ \"va", Draft("{ \"va"));
        for (var i = 1; i < key.Length; i++)
            Assert.Equal(head, Draft(head + key[..i]));
        Assert.Equal(head + escaped, Draft(head + key));
        Assert.Equal(head + escaped + "\", \"n", Draft(head + key + "\", \"n"));

        var complete =
            "{ \"value\": \"to " + key + "\", \"nested\": [\"" + key + "\", \"" + unknown + "\"] }";
        var draft = Draft(complete)!;
        // Formatting is the provider's own; only placeholders change.
        Assert.Equal(complete.Replace(key, escaped), draft);
        var parsed = JsonNode.Parse(draft)!;
        Assert.Equal("to " + secret, parsed["value"]!.GetValue<string>());
        Assert.Equal(secret, parsed["nested"]![0]!.GetValue<string>());
        Assert.Equal(unknown, parsed["nested"]![1]!.GetValue<string>());
        // Arguments without placeholders are passed through unchanged.
        Assert.Equal("{\"a\" : 1", Draft("{\"a\" : 1"));
    }
}
