using System.Text.Json.Nodes;
using Foxwarm.Secrets;

namespace Foxwarm.Tests;

public sealed class SecretLiteralMoveTests
{
    private const string Literal = "sk-synthetic-literal-0123";
    private const string Reference = "${secret:moved-key}";

    private static IReadOnlyList<SecretLiteralMove.Location> Locations(string json) =>
        SecretLiteralMove.Parse(JsonNode.Parse(json));

    private static string Move(string yaml, string locations, SecretSinks? sinks = null)
    {
        var listed = Locations(locations);
        var literal = SecretLiteralMove.ReadYaml(
            yaml,
            listed,
            sinks ?? SecretSinks.Models,
            "models config"
        );
        Assert.Equal(Literal, literal);
        return SecretLiteralMove.RewriteYaml(yaml, listed, literal, Reference, "models config");
    }

    [Fact]
    public void Only_the_listed_scalars_change_whatever_their_quoting()
    {
        var yaml = string.Join(
            "\r\n",
            "# Credentials, édités à la main 🦊",
            "providers:",
            "  plain:",
            $"    apiKey: {Literal}   # trailing comment",
            "    models: [a]",
            "  single:",
            $"    apiKey: '{Literal}'",
            "  double:",
            $"    apiKey: \"{Literal}\"",
            "  flow: {apiKey: " + Literal + ", models: [b]}",
            "  headers:",
            "    extraHeaders:",
            $"      X-Token: {Literal}",
            "    models:",
            "      - id: c",
            "        extraHeaders: {X-Other: kept-literal}",
            ""
        );
        var rewritten = Move(
            yaml,
            """
            [
              {"target":"models","path":["providers","plain","apiKey"]},
              {"target":"models","path":["providers","single","apiKey"]},
              {"target":"models","path":["providers","double","apiKey"]},
              {"target":"models","path":["providers","flow","apiKey"]},
              {"target":"models","path":["providers","headers","extraHeaders","X-Token"]}
            ]
            """
        );
        Assert.DoesNotContain(Literal, rewritten);
        Assert.Equal(
            yaml.Replace("'" + Literal + "'", "\"" + Reference + "\"", StringComparison.Ordinal)
                .Replace("\"" + Literal + "\"", "\"" + Reference + "\"", StringComparison.Ordinal)
                .Replace(Literal, "\"" + Reference + "\"", StringComparison.Ordinal),
            rewritten
        );
        var parsed = ConfigurationYaml.Parse(rewritten, "models config");
        Assert.Equal(Reference, (string?)parsed["providers"]!["flow"]!["apiKey"]);
        Assert.Equal(
            "kept-literal",
            (string?)parsed["providers"]!["headers"]!["models"]![0]!["extraHeaders"]!["X-Other"]
        );
    }

    [Fact]
    public void Values_that_are_not_one_literal_written_in_place_are_refused()
    {
        void Refused(string yaml, string path, string message, SecretSinks? sinks = null)
        {
            var error = Assert.Throws<InvalidDataException>(() =>
                Move(yaml, $$$"""[{"target":"models","path":{{{path}}}}]""", sinks)
            );
            Assert.Contains(message, error.Message);
        }
        const string Path = """["providers","p","apiKey"]""";
        Refused(
            $"providers:\n  p:\n    apiKey: &key {Literal}\n  q:\n    apiKey: *key\n",
            Path,
            "single-line value written directly"
        );
        Refused(
            $"base: &base\n  apiKey: {Literal}\nproviders:\n  p:\n    <<: *base\n",
            Path,
            "not found"
        );
        Refused($"providers:\n  p: &p\n    apiKey: {Literal}\n", Path, "YAML anchor");
        Refused($"providers:\n  p:\n    apiKey: |-\n      {Literal}\n", Path, "single-line");
        Refused("providers:\n  p:\n    apiKey: '${secret:other}'\n", Path, "already uses");
        Refused("providers:\n  p:\n    apiKey: ''\n", Path, "is empty");
        Refused("providers:\n  p:\n    apiKey: 12345\n", Path, "does not hold text");
        Refused(
            $"providers:\n  p:\n    baseUrl: {Literal}\n",
            """["providers","p","baseUrl"]""",
            "not a credential field"
        );
        Refused(
            $"providers:\n  p:\n    apiKey: {Literal}\n  q:\n    apiKey: other-literal\n",
            """["providers","p","apiKey"]},{"target":"models","path":["providers","q","apiKey"]""",
            "different values"
        );
    }

    [Fact]
    public void Locations_are_validated_before_anything_is_read()
    {
        foreach (
            var invalid in new[]
            {
                "[]",
                """[{"target":"vault","path":["a"]}]""",
                """[{"target":"models","path":[]}]""",
                """[{"target":"models","path":[-1]}]""",
                """[{"target":"models","path":["a"],"extra":1}]""",
                """[{"target":"mcp","path":["server"]}]""",
                """[{"target":"models","path":["a"]},{"target":"models","path":["a"]}]""",
            }
        )
            Assert.ThrowsAny<Exception>(() => Locations(invalid));
        Assert.Equal(
            ["models:providers.p.models[0].extraHeaders.X"],
            Locations(
                    """[{"target":"models","path":["providers","p","models",0,"extraHeaders","X"]}]"""
                )
                .Select(location => location.Display)
        );
    }

    [Fact]
    public void Mcp_moves_patch_whole_top_level_fields_from_the_snapshot()
    {
        var servers = JsonNode
            .Parse(
                $$$"""
                {
                  "remote": {"url":"https://example.invalid/mcp","token":"{{{Literal}}}","headers":{"X-A":"{{{Literal}}}","X-B":"kept"}},
                  "local": {"command":"tool","args":["--port","1","{{{Literal}}}"],"env":{"TOKEN":"{{{Literal}}}","MODE":"x"}},
                  "oauth": {"url":"https://{{{Literal}}}.example.invalid/mcp","oauth":{"clientId":"c"}}
                }
                """
            )!
            .AsObject();
        var (literal, patches) = SecretLiteralMove.Mcp(
            servers,
            Locations(
                """
                [
                  {"target":"mcp","path":["remote","token"]},
                  {"target":"mcp","path":["remote","headers","X-A"]},
                  {"target":"mcp","path":["local","args",2]},
                  {"target":"mcp","path":["local","env","TOKEN"]}
                ]
                """
            ),
            Reference
        );
        Assert.Equal(Literal, literal);
        Assert.True(
            JsonNode.DeepEquals(
                JsonNode.Parse(
                    $$$"""{"token":"{{{Reference}}}","headers":{"X-A":"{{{Reference}}}","X-B":"kept"}}"""
                ),
                patches["remote"]
            )
        );
        Assert.True(
            JsonNode.DeepEquals(
                JsonNode.Parse(
                    $$$"""{"args":["--port","1","{{{Reference}}}"],"env":{"TOKEN":"{{{Reference}}}","MODE":"x"}}"""
                ),
                patches["local"]
            )
        );
        var oauth = Assert.Throws<InvalidDataException>(() =>
            SecretLiteralMove.Mcp(
                servers,
                Locations("""[{"target":"mcp","path":["oauth","url"]}]"""),
                Reference
            )
        );
        Assert.Contains("OAuth", oauth.Message);
        Assert.Throws<InvalidDataException>(() =>
            SecretLiteralMove.Mcp(
                servers,
                Locations("""[{"target":"mcp","path":["local","command"]}]"""),
                Reference
            )
        );
    }
}
