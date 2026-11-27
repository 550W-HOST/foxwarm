using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

// Setup > Authorization: the complete global tool authorization policy as text. Saves install
// through the same configuration installer as set_config's tool-rules target and carry the
// revision they were edited from, so a policy changed meanwhile is never silently replaced.
// Administrator-only: these routes are not on WebUiAccess.BrowserRoute's scoped allowlist.
internal sealed partial class WebUIChannel
{
    // The revision a save carried no longer names the active policy.
    private sealed class PolicyRevisionConflictException(string current)
        : Exception("This policy changed after you opened it.")
    {
        internal string Current => current;
    }

    private void RegisterAuthorizationSetupRoutes(
        WebApplication app,
        ModelConfiguration configuration
    )
    {
        var authority = sessions.Authorization;
        app.MapGet(
            "/api/setup/authorization",
            async (CancellationToken token) =>
            {
                try
                {
                    var (bytes, revision) = await authority.ReadActiveFileAsync(token);
                    var result = PolicyState(bytes, revision);
                    if (bytes is not null)
                        try
                        {
                            var policy = ToolAuthorizationYaml.Parse(bytes);
                            if (policy.Warnings.Count > 0)
                                result["warnings"] = Warnings(policy);
                        }
                        catch (InvalidDataException error)
                        {
                            // The active file is unusable; authorization fails closed until it
                            // is replaced, and the editor shows why.
                            result["error"] = error.Message;
                        }
                    return Results.Ok(result);
                }
                catch (Exception error) when (error is InvalidDataException or IOException)
                {
                    return Results.Json(
                        new JsonObject { ["error"] = configuration.SafeAppError(error) },
                        statusCode: 500
                    );
                }
            }
        );
        app.MapPost(
            "/api/setup/authorization",
            async (HttpRequest request, CancellationToken token) =>
            {
                try
                {
                    var input =
                        await JsonNode.ParseAsync(request.Body, cancellationToken: token)
                            as JsonObject
                        ?? throw new InvalidDataException("Policy input must be an object.");
                    ToolRegistry.Keys(input, ["yaml", "revision"]);
                    var text =
                        input["yaml"] is JsonValue yaml && yaml.TryGetValue<string>(out var value)
                            ? value
                            : throw new InvalidDataException("Policy yaml must be a string.");
                    var expected =
                        input["revision"] is JsonValue loaded
                        && loaded.TryGetValue<string>(out var revision)
                            ? revision
                            : throw new InvalidDataException("Policy revision must be a string.");
                    var bytes = new UTF8Encoding(false).GetBytes(text);
                    var installed = await configuration.InstallAsync(
                        "tool-rules",
                        _ => Task.FromResult(bytes),
                        authority,
                        // Inside the installer's lane, which every policy installation shares.
                        async current =>
                        {
                            var active = (await authority.ReadActiveFileAsync(current)).Revision;
                            if (active != expected)
                                throw new PolicyRevisionConflictException(active);
                        },
                        token
                    );
                    var state = PolicyState(bytes, ToolAuthorizationAuthority.Revision(bytes));
                    foreach (var (key, field) in state)
                        installed[key] = field?.DeepClone();
                    var policy = ToolAuthorizationYaml.Parse(bytes);
                    if (policy.Warnings.Count > 0)
                        installed["warnings"] = Warnings(policy);
                    return Results.Ok(installed);
                }
                catch (PolicyRevisionConflictException conflict)
                {
                    return Results.Json(
                        new JsonObject
                        {
                            ["error"] = conflict.Message,
                            ["code"] = "policy_changed",
                            ["revision"] = conflict.Current,
                        },
                        statusCode: 409
                    );
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                    )
                {
                    return Results.BadRequest(
                        new JsonObject
                        {
                            ["error"] =
                                error is JsonException
                                    ? "Policy input must be JSON."
                                    : configuration.SafeAppError(error),
                        }
                    );
                }
            }
        );
    }

    private static JsonObject PolicyState(byte[]? bytes, string revision) =>
        new()
        {
            ["exists"] = bytes is not null,
            ["yaml"] = bytes is null ? "" : Text(bytes),
            ["revision"] = revision,
        };

    // The stored text as the editor shows it: UTF-8 without a leading byte order mark.
    private static string Text(byte[] bytes)
    {
        var text = new UTF8Encoding(false, false).GetString(bytes);
        return text.StartsWith('\uFEFF') ? text[1..] : text;
    }

    private static JsonArray Warnings(ToolAuthorizationPolicy policy) =>
        new(policy.Warnings.Select(warning => (JsonNode?)warning).ToArray());
}
