using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class SecretSetupRouteTests
{
    private const string Value = "sk-synthetic-setup-value-0003";

    [Fact]
    public async Task Setup_secrets_are_write_only_and_bootstrap_pairing_tokens_go_to_an_owner_only_file()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "vector: false\nllm:\n  openaiApiKey: ${secret:fallback-key}\n"
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var settings = (await HttpServerSettings.CaptureAsync(configuration, temp.Path)) with
        {
            Port = 0,
            BindAddress = "127.0.0.1",
            Address = new("http://127.0.0.1", "", "/", false),
        };
        await using var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        Assert.True(File.Exists(Path.Combine(temp.Path, "keys", "secrets.key")));
        using var client = new HttpClient
        {
            BaseAddress = new Uri(host.App.Urls.Single()),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);

        var status = (await client.GetFromJsonAsync<JsonObject>("/api/setup/secrets"))!;
        Assert.False(status["locked"]!.GetValue<bool>());
        Assert.Empty(status["secrets"]!.AsArray());
        var missing = Assert.Single(status["missing"]!.AsArray())!;
        Assert.Equal("fallback-key", missing["name"]!.GetValue<string>());
        Assert.Equal("llm.openaiApiKey", missing["usages"]![0]!["id"]!.GetValue<string>());

        var saved = await client.PutAsJsonAsync(
            "/api/setup/secrets/fallback-key",
            new JsonObject { ["value"] = Value, ["description"] = "Synthetic fallback" }
        );
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var savedText = await saved.Content.ReadAsStringAsync();
        Assert.DoesNotContain(Value, savedText);
        Assert.Null(JsonNode.Parse(savedText)!["warning"]);

        var shortValue = await client.PutAsJsonAsync(
            "/api/setup/secrets/pin",
            new JsonObject { ["value"] = "short-pin" }
        );
        Assert.Equal(HttpStatusCode.OK, shortValue.StatusCode);
        Assert.Contains("cannot be hidden", (await shortValue.Content.ReadAsStringAsync()));

        var invalid = await client.PutAsJsonAsync(
            "/api/setup/secrets/Not%20Valid",
            new JsonObject { ["value"] = Value }
        );
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        var listed = await client.GetStringAsync("/api/setup/secrets");
        Assert.DoesNotContain(Value, listed);
        Assert.DoesNotContain("short-pin\"", listed.Replace("\"name\":\"pin\"", ""));
        var listedJson = JsonNode.Parse(listed)!;
        Assert.Empty(listedJson["missing"]!.AsArray());
        var fallback = listedJson["secrets"]!
            .AsArray()
            .Single(item => item!["name"]!.GetValue<string>() == "fallback-key")!;
        Assert.True(fallback["isSet"]!.GetValue<bool>());
        Assert.Equal("Synthetic fallback", fallback["description"]!.GetValue<string>());
        Assert.Equal("setting", fallback["usages"]![0]!["kind"]!.GetValue<string>());

        var manager = host.Sessions;
        Assert.Equal(Value, manager.Secrets!.Lookup("fallback-key"));

        var deleted = await client.DeleteAsync("/api/setup/secrets/fallback-key");
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        Assert.Null(manager.Secrets.Lookup("fallback-key"));
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await client.DeleteAsync("/api/setup/secrets/absent")).StatusCode
        );
        Assert.Equal("[[FW_SECRET:fallback-key]]", manager.Secrets.Redactor.Redact(Value));

        var tokenFile = Path.Combine(temp.Path, "pairing-token");
        var info = await manager.NodeBootstrapInfoAsync(
            new JsonObject { ["filePath"] = tokenFile },
            CancellationToken.None
        );
        var pairing = manager.Nodes.Registry.PairingToken;
        var output = info["output"]!.GetValue<string>();
        Assert.DoesNotContain(pairing, output);
        Assert.Contains("PAIRING_TOKEN", output);
        Assert.Equal(tokenFile, JsonNode.Parse(output)!["pairingTokenFile"]!.GetValue<string>());
        Assert.Equal(pairing + "\n", await File.ReadAllTextAsync(tokenFile));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite,
            File.GetUnixFileMode(tokenFile)
        );
        await Assert.ThrowsAsync<IOException>(() =>
            manager.NodeBootstrapInfoAsync(
                new JsonObject { ["filePath"] = tokenFile },
                CancellationToken.None
            )
        );
        Assert.Equal("[[FW_SECRET:node-pairing-token]]", manager.Secrets.Redactor.Redact(pairing));
    }
}
