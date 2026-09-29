using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private readonly SemaphoreSlim settingsGate = new(1, 1);
    private void RegisterPresentationRoutes(WebApplication app)
    {
        app.MapGet("/api/webui/settings", () => Results.Ok(new { settings = ReadSettings() }));
        app.MapPost("/api/webui/settings", async (HttpRequest request) =>
        {
            await settingsGate.WaitAsync();
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? throw new InvalidDataException("Settings must be an object.");
                if (body.Any(pair => pair.Key is not ("instanceName" or "tabIcon"))) throw new InvalidDataException("Unsupported settings fields.");
                var settings = ReadSettings();
                foreach (var key in new[] { "instanceName", "tabIcon" })
                {
                    if (!body.ContainsKey(key)) continue;
                    if (body[key] is not null && (body[key] is not JsonValue value || !value.TryGetValue<string>(out _)))
                        throw new InvalidDataException($"{key} must be a string.");
                    var normalized = Regex.Replace(Regex.Replace(body[key]?.GetValue<string>() ?? "", "[\\x00-\\x1f\\x7f]", " "), "\\s+", " ").Trim();
                    if (key == "instanceName" ? normalized.Length > 80 : normalized.EnumerateRunes().Count() > 16)
                        throw new InvalidDataException($"{key} is too long.");
                    settings[key] = normalized;
                }
                var file = Path.Combine(sessions.DataRoot, "state", "webui.json");
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                var temp = file + ".tmp-" + Guid.NewGuid().ToString("N");
                await File.WriteAllTextAsync(temp, settings.ToJsonString()); File.Move(temp, file, overwrite: true);
                return Results.Ok(new { success = true, settings });
            }
            catch (Exception error) when (error is InvalidDataException or System.Text.Json.JsonException)
            { return Results.BadRequest(new { error = error.Message }); }
            finally { settingsGate.Release(); }
        });
        app.MapPost("/api/sessions/{id}/name", async (string id, HttpRequest request) =>
        {
            var owner = FindRoute(request, id); if (owner is null) return Results.NotFound(new { error = "Session not found" });
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? throw new InvalidDataException("Name must be an object.");
                if (body.Any(pair => pair.Key != "name")) throw new InvalidDataException("Unsupported name fields.");
                var name = body["name"] is JsonValue value && value.TryGetValue<string>(out var text) && text.Trim().Length > 0 ? text.Trim() : null;
                await runtime.UpdateDisplayNameAsync(owner.Id, name);
                return Results.Ok(new { success = true, sessionId = owner.Id, displayName = name });
            }
            catch (Exception error) when (error is InvalidDataException or System.Text.Json.JsonException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
    }
    private JsonObject ReadSettings()
    {
        try
        {
            var path = Path.Combine(sessions.DataRoot, "state", "webui.json");
            if (File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject settings)
                return new JsonObject
                {
                    ["instanceName"] = settings["instanceName"]?.DeepClone() ?? JsonValue.Create(""),
                    ["tabIcon"] = settings["tabIcon"]?.DeepClone() ?? JsonValue.Create("")
                };
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException) { }
        return new JsonObject { ["instanceName"] = "", ["tabIcon"] = "" };
    }
}
