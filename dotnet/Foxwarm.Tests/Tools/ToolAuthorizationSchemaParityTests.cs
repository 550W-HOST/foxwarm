using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Tools;

// The shared editor schema of the policy (packages/shared/src/toolAuthorizationPolicySchema.ts)
// is written from this parser. Its corpus records the parser's verdicts, which the WebUI schema
// test checks the schema against; its operation list must be the catalog's.
public sealed class ToolAuthorizationSchemaParityTests
{
    private static JsonArray Cases() =>
        JsonNode
            .Parse(
                File.ReadAllText(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "Tools",
                        "Fixtures",
                        "toolAuthorizationPolicySchema.fixtures.json"
                    )
                )
            )!["cases"]!
            .AsArray();

    [Fact]
    public void Corpus_verdicts_are_the_parsers()
    {
        var cases = Cases();
        Assert.Contains(cases, item => item!["valid"]!.GetValue<bool>());
        Assert.Contains(cases, item => !item!["valid"]!.GetValue<bool>());
        foreach (var item in cases)
        {
            var name = item!["name"]!.GetValue<string>();
            var bytes = Encoding.UTF8.GetBytes(item["yaml"]!.GetValue<string>());
            if (item["valid"]!.GetValue<bool>())
            {
                var error = Record.Exception(() => ToolAuthorizationYaml.Parse(bytes));
                Assert.True(error is null, $"{name}: {error?.Message}");
            }
            else
                Assert.True(
                    Record.Exception(() => ToolAuthorizationYaml.Parse(bytes))
                        is InvalidDataException,
                    name
                );
        }
    }

    [Fact]
    public void Schema_operations_are_the_catalog()
    {
        var source = File.ReadAllText(
            Path.Combine(
                VectorFixture.Repository(),
                "packages",
                "shared",
                "src",
                "toolAuthorizationPolicySchema.ts"
            )
        );
        var list = Regex.Match(
            source,
            @"TOOL_AUTHORIZATION_OPERATIONS = \[(?<items>[^\]]*)\]",
            RegexOptions.CultureInvariant
        );
        Assert.True(list.Success);
        var declared = Regex
            .Matches(list.Groups["items"].Value, "'([^']+)'")
            .Select(match => match.Groups[1].Value)
            .ToArray();
        Assert.Equal(OperationDeclarations.Operations.Select(spec => spec.Op), declared);
    }
}
