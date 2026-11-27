using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private readonly SemaphoreSlim settingsGate = new(1, 1);

    private void RegisterPresentationRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/webui/settings",
            () =>
                Results.Ok(
                    new JsonObject { ["settings"] = JsonData.WebNode(Presented(ReadSettings())) }
                )
        );
        app.MapPost(
            "/api/webui/settings",
            async (HttpRequest request) =>
            {
                await settingsGate.WaitAsync();
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Settings must be an object.");
                    if (body.Any(pair => pair.Key is not ("instanceName" or "tabIcon")))
                        throw new InvalidDataException("Unsupported settings fields.");
                    var settings = ReadSettings();
                    foreach (var key in new[] { "instanceName", "tabIcon" })
                    {
                        if (!body.ContainsKey(key))
                            continue;
                        if (
                            body[key] is not null
                            && (
                                body[key] is not JsonValue value
                                || !value.TryGetValue<string>(out _)
                            )
                        )
                            throw new InvalidDataException($"{key} must be a string.");
                        var normalized = Regex
                            .Replace(
                                Regex.Replace(
                                    body[key]?.GetValue<string>() ?? "",
                                    "[\\x00-\\x1f\\x7f]",
                                    " "
                                ),
                                "\\s+",
                                " "
                            )
                            .Trim();
                        if (
                            key == "instanceName"
                                ? normalized.Length > 80
                                : normalized.EnumerateRunes().Count() > 16
                        )
                            throw new InvalidDataException($"{key} is too long.");
                        settings[key] = normalized;
                    }
                    new AtomicJsonFile(
                        sessions.DataRoot,
                        Path.Combine("state", "webui.json")
                    ).WritePayload(settings);
                    return Results.Ok(
                        new JsonObject
                        {
                            ["success"] = true,
                            ["settings"] = JsonData.WebNode(Presented(settings)),
                        }
                    );
                }
                catch (Exception error)
                    when (error is InvalidDataException or System.Text.Json.JsonException)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                finally
                {
                    settingsGate.Release();
                }
            }
        );
        app.MapPost(
            "/api/sessions/{id}/name",
            async (string id, HttpRequest request) =>
            {
                var canonical = CatalogRoute(request);
                if (canonical is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                try
                {
                    var body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Name must be an object.");
                    if (body.Any(pair => pair.Key != "name"))
                        throw new InvalidDataException("Unsupported name fields.");
                    var name =
                        body["name"] is JsonValue value
                        && value.TryGetValue<string>(out var text)
                        && text.Trim().Length > 0
                            ? text.Trim()
                            : null;
                    await runtime.UpdateDisplayNameAsync(canonical, name);
                    return Results.Ok(
                        new JsonObject
                        {
                            ["success"] = true,
                            ["sessionId"] = canonical,
                            ["displayName"] = name,
                        }
                    );
                }
                catch (Exception error)
                    when (error is InvalidDataException or System.Text.Json.JsonException)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
            }
        );
    }

    /// <summary>
    /// Records the WebUI defaults of a new installation at its first models save: Enter sends
    /// in browsers that never chose a send key. A failure leaves the previous default.
    /// </summary>
    private async Task RecordFirstRunWebUiDefaultsAsync()
    {
        await settingsGate.WaitAsync();
        try
        {
            var settings = ReadSettings();
            settings["sendKeyDefault"] = "enter";
            new AtomicJsonFile(sessions.DataRoot, Path.Combine("state", "webui.json")).WritePayload(
                settings
            );
        }
        catch (Exception error)
        {
            MainLog.Diagnostic(
                "First-run WebUI defaults were not saved: " + MainLog.SafeFailure(error),
                failure: true
            );
        }
        finally
        {
            settingsGate.Release();
        }
    }

    /// <summary>
    /// The settings as the WebUI reads them. Installations without the first-run record
    /// keep Ctrl/Cmd+Enter; the default is presented, never written.
    /// </summary>
    private static JsonObject Presented(JsonObject settings)
    {
        var presented = (JsonObject)settings.DeepClone();
        presented["sendKeyDefault"] ??= "modEnter";
        return presented;
    }

    private JsonObject ReadSettings()
    {
        try
        {
            var path = Path.Combine(sessions.DataRoot, "state", "webui.json");
            if (File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject settings)
            {
                var result = new JsonObject
                {
                    ["instanceName"] =
                        settings["instanceName"]?.DeepClone() ?? JsonValue.Create(""),
                    ["tabIcon"] = settings["tabIcon"]?.DeepClone() ?? JsonValue.Create(""),
                };
                if (SessionWait.Text(settings["sendKeyDefault"]) is "enter" or "modEnter")
                    result["sendKeyDefault"] = SessionWait.Text(settings["sendKeyDefault"]);
                return result;
            }
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException) { }
        return new JsonObject { ["instanceName"] = "", ["tabIcon"] = "" };
    }
}
