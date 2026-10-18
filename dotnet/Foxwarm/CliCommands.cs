using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

// The public JavaScript frontend owns flag parsing/help and stdin collection.
// These one-shot operations share runtime owners, never MainHost/SessionManager.
internal static class CliCommands
{
    private sealed class UsageException(string message) : Exception(message);

    internal static bool IsCommand(string[] args) =>
        args is ["--cli-model"] or ["--cli-archive"];

    internal static async Task<int> RunAsync(string command)
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var input = JsonNode.Parse(await Console.In.ReadLineAsync() ?? "") as JsonObject
                ?? throw new InvalidDataException("Expected a CLI input document.");
            var configuration = new ModelConfiguration(HostPaths.Capture());
            if (command == "--cli-model")
                await ModelAsync(configuration, input);
            else
                await ArchiveAsync(configuration.Paths.DataRoot, input);
            return 0;
        }
        catch (Exception error)
        {
            await Console.Error.WriteLineAsync(
                (error is UsageException ? "Usage error: " : "Error: ") + error.Message
            );
            return error is UsageException ? 2 : 1;
        }
    }

    private static async Task ModelAsync(ModelConfiguration configuration, JsonObject input)
    {
        var catalog = configuration.Models.Capture();
        if (input["list"]?.GetValue<bool>() == true)
        {
            Console.WriteLine($"Default: {(catalog.DefaultKey.Length == 0 ? "(none)" : catalog.DefaultKey)}\n\nAvailable models:");
            foreach (var entry in catalog.Options)
            {
                var marker = entry.Key == catalog.DefaultKey ? " (default)" : "";
                var model = entry.ModelId.Length == 0 ? "" : " -> " + entry.ModelId;
                Console.WriteLine($"  {entry.Key}{marker}{model}");
                if (entry.ProviderType.Length > 0)
                    Console.WriteLine("    provider: " + entry.ProviderType);
                if (!string.IsNullOrEmpty(entry.BaseUrl))
                    Console.WriteLine("    baseUrl:  " + entry.BaseUrl);
            }
            return;
        }
        var key = SessionWait.Text(input["model"]);
        if (!string.IsNullOrEmpty(key) && !catalog.Contains(key))
            throw new UsageException($"Unknown model key: {key}. Use `foxwarm model --list` to inspect configured keys.");
        var prompt = input.ContainsKey("prompt") ? SessionWait.Text(input["prompt"]) : await Console.In.ReadToEndAsync();
        if (prompt is null || OpenAIRequestText.Trim(prompt).Length == 0)
            throw new UsageException("No prompt provided. Use --prompt or pipe text through stdin.");
        var root = configuration.Paths.DataRoot;
        await using var journal = new LlmRequestJournalStore(root);
        await SqliteOnlyArchivesMigration.RunAsync(root, journal);
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        await using var websockets = new ResponsesWsTransport();
        var defaults = new ResponsesClientOptions(new Uri("http://localhost"), "", "", "", "", configuration.MaxOutput, new JsonArray())
        {
            HardTimeoutMs = SessionWait.Number(input["timeoutMs"]),
        };
        var owner = new ModelRequestOwner(http, defaults, new ModelRouting(), websockets: websockets, journal: journal);
        var result = await owner.RequestAsync(
            "", catalog, key ?? catalog.DefaultKey, null,
            Guid.NewGuid().ToString(), Guid.NewGuid().ToString(),
            [new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = prompt }) }],
            (_, _) => Task.FromResult(SessionWait.Text(input["system"]) ?? ""),
            null, null, null, error => Console.Error.WriteLine("Warning: " + error.Message),
            CancellationToken.None, journalPurpose: "cli", journalIteration: 0
        );
        // Low-level one-shot calls must not retain a reusable WS history chain.
        result.FinalizeHistory(null);
        var text = string.Concat((result.AssistantMessage?["parts"] as JsonArray ?? new JsonArray())
            .OfType<JsonObject>().Select(part => SessionWait.Text(part["text"]) ?? ""));
        if (OpenAIRequestText.Trim(text).Length == 0)
            throw new InvalidDataException("Model returned an empty text response.");
        if (input["json"]?.GetValue<bool>() == true)
            Console.WriteLine(new JsonObject
            {
                ["text"] = text,
                ["modelId"] = result.AssistantMessage?["__meta"]?["modelId"]?.DeepClone(),
                ["usage"] = result.Usage?.DeepClone(),
            }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        else
        {
            Console.Write(text);
            if (!text.EndsWith('\n'))
                Console.WriteLine();
        }
    }

    private static async Task ArchiveAsync(string root, JsonObject input)
    {
        var output = Path.GetFullPath(input["output"]!.GetValue<string>());
        await using var journal = new LlmRequestJournalStore(root);
        await SqliteOnlyArchivesMigration.RunAsync(root, journal);
        var sessions = await SqliteArchiveMessageStore.ExportJsonlAsync(
            Path.Combine(root, "state", "archive-store.sqlite"), Path.Combine(output, "sessions"));
        var records = await journal.ExportJsonlAsync(Path.Combine(output, "llm-request-journal.jsonl"));
        Console.WriteLine(JsonSerializer.Serialize(new { output, sessions = new { files = sessions.Files, records = sessions.Records }, llm = new { records } },
            new JsonSerializerOptions { WriteIndented = true }));
    }
}
