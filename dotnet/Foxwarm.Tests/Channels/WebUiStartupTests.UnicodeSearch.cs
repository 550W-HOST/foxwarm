using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Real_Main_metadata_search_matches_Unicode17_case_pairs_and_contextual_sigma()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath, "vector: false\ndbWorkers: false\n");
        await File.WriteAllTextAsync(
            Path.Combine(h.Data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
        );
        h.Start();
        await h.Ready();
        var pairs = new[]
        {
            ("꟎", "꟏"),
            ("꟒", "ꟓ"),
            ("꟔", "ꟕ"),
            ("\U00016EA0", "\U00016EBB"),
            ("ΑΣ꟎", "ασ꟏"),
            ("ΑΣ\u1ACFΑ", "ασ\u1ACFα"),
            ("Q", "q"),
            ("ΟΣ", "ος"),
            ("İ", "i\u0307"),
            ("𐐀", "𐐨"),
        };
        for (var index = 0; index < pairs.Length; index++)
        {
            var (upper, lower) = pairs[index];
            foreach (var (suffix, name) in new[] { ("upper", upper), ("lower", lower) })
            {
                var id = $"unicode-{index}-{suffix}";
                var created = await h.Client.PostAsJsonAsync(
                    "/api/sessions", new { agentId = "main", sessionId = id }
                );
                Assert.Equal(HttpStatusCode.OK, created.StatusCode);
                var named = await h.Client.PostAsJsonAsync(
                    $"/api/sessions/{id}/name", new { name }
                );
                Assert.Equal(HttpStatusCode.OK, named.StatusCode);
            }
            foreach (var query in new[] { upper, lower })
            {
                var response = await h.Client.GetAsync(
                    "/api/session-list/search?q=" + Uri.EscapeDataString(query) + "&limit=100"
                );
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                var result = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
                var ids = result["sessions"]!.AsArray()
                    .Select(row => row!["id"]!.GetValue<string>()).Order().ToArray();
                Assert.Equal(new[] { $"unicode-{index}-lower", $"unicode-{index}-upper" }, ids);
            }
        }
        var absent = await h.Client.GetFromJsonAsync<JsonObject>(
            "/api/session-list/search?q=" + Uri.EscapeDataString("absent metadata 🦊")
        );
        Assert.Empty(absent!["sessions"]!.AsArray());
        await h.Stop();
    }
}
