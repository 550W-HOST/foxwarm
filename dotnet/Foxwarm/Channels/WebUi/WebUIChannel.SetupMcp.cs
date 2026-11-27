using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

// Setup > MCP: the outbound MCP servers of state/mcp.json. Every change goes through the managed
// configuration lane (validation, persist before publish, live apply) and carries the revision
// of the server it was edited from, so a change made meanwhile (ctl mcp, mcp_config) is refused
// rather than overwritten. Administrator-only: not on WebUiAccess.BrowserRoute's allowlist.
internal sealed partial class WebUIChannel
{
    private sealed class McpRevisionConflictException()
        : Exception("This server changed after you opened it.");

    private void RegisterMcpSetupRoutes(WebApplication app, ModelConfiguration configuration)
    {
        var client = sessions.OutboundMcp;
        app.MapGet(
            "/api/setup/mcp",
            () => McpRoute(client, () => Task.FromResult(McpSetupState(client, configuration)))
        );
        app.MapPut(
            "/api/setup/mcp/{name}",
            (HttpRequest request, string name) =>
                McpRoute(
                    client,
                    async () =>
                    {
                        var input = await McpInputAsync(request, ["server", "revision"]);
                        var server =
                            input["server"] as JsonObject
                            ?? throw new InvalidDataException("Server must be an object.");
                        var expected = McpRevision(input);
                        await client.ReplaceServerAsync(
                            McpServerName(name),
                            stored =>
                            {
                                McpAdmit(stored, expected);
                                return McpClient.FromSetupView(server, stored);
                            }
                        );
                        return McpServerState(client, name, null);
                    }
                )
        );
        app.MapPost(
            "/api/setup/mcp/{name}/delete",
            (HttpRequest request, string name) =>
                McpRoute(
                    client,
                    async () =>
                    {
                        var expected = McpRevision(await McpInputAsync(request, ["revision"]));
                        await client.RemoveServerAsync(
                            McpServerName(name),
                            stored => McpAdmit(stored, expected)
                        );
                        return new JsonObject { ["deleted"] = true };
                    }
                )
        );
        app.MapPost(
            "/api/setup/mcp/{name}/check",
            (HttpRequest request, string name) =>
                McpRoute(
                    client,
                    async () =>
                    {
                        var observed = await client.ProbeAsync(
                            McpServerName(name),
                            request.HttpContext.RequestAborted
                        );
                        return new JsonObject { ["observed"] = observed };
                    }
                )
        );
    }

    // A change applies only to the server as it was loaded; a new server only while absent.
    private static void McpAdmit(JsonObject? stored, string expected)
    {
        if (McpClient.Revision(stored) != expected)
            throw new McpRevisionConflictException();
    }

    private static string McpServerName(string name) =>
        string.IsNullOrWhiteSpace(name) || name.Trim() != name || name.Length > 128
            ? throw new InvalidDataException("Server names can't be blank or start or end with a space.")
            : name;

    private static string McpRevision(JsonObject input) =>
        input["revision"] is JsonValue value && value.TryGetValue<string>(out var revision)
            ? revision
            : throw new InvalidDataException("Server revision must be a string.");

    private static async Task<JsonObject> McpInputAsync(HttpRequest request, string[] keys)
    {
        var input =
            await JsonNode.ParseAsync(
                request.Body,
                cancellationToken: request.HttpContext.RequestAborted
            ) as JsonObject
            ?? throw new InvalidDataException("Use a JSON object for this action.");
        ToolRegistry.Keys(input, keys);
        return input;
    }

    private static async Task<IResult> McpRoute(McpClient client, Func<Task<JsonObject>> action)
    {
        try
        {
            return Results.Ok(JsonData.WebNode(await action()));
        }
        catch (McpRevisionConflictException conflict)
        {
            return Results.Json(
                new JsonObject { ["error"] = conflict.Message, ["code"] = "server_changed" },
                statusCode: 409
            );
        }
        catch (Exception error)
            when (error
                    is JsonException
                        or InvalidDataException
                        or InvalidOperationException
                        or IOException
                        or AuthorityCommittedException
                        or SecretStoreLockedException
                        or McpOAuthException
            )
        {
            // Validation messages are fixed text about the submitted definition; anything else
            // may quote an underlying error and is redacted against the configured credentials.
            var message = error switch
            {
                JsonException => "Use a JSON object for this action.",
                InvalidDataException or AuthorityCommittedException or McpOAuthException =>
                    error.Message,
                _ => client.Configuration.Redact(error.Message),
            };
            return Results.BadRequest(new JsonObject { ["error"] = message });
        }
    }

    private static JsonObject McpServerState(McpClient client, string name, JsonObject? stored)
    {
        stored ??=
            client.Configuration.Snapshot()[name] as JsonObject
            ?? throw new InvalidDataException("MCP server not found: " + name);
        var state = new JsonObject
        {
            ["name"] = name,
            ["revision"] = McpClient.Revision(stored),
            ["server"] = McpClient.SetupView(stored),
            ["observed"] = client.Observed(name),
        };
        if (stored["oauth"] is not null && SessionWait.Text(stored["transport"]) != "stdio")
            state["oauth"] = client.OAuth.Status(name, stored);
        return state;
    }

    private static JsonObject McpSetupState(McpClient client, ModelConfiguration configuration)
    {
        var servers = new JsonArray();
        foreach (var (name, stored) in client.Configuration.Snapshot())
            servers.Add(McpServerState(client, name, stored!.AsObject()));
        JsonArray secrets;
        try
        {
            secrets = new JsonArray(
                configuration
                    .Secrets.Store.List()
                    .Where(item => item.IsSet)
                    .Select(item => (JsonNode?)JsonValue.Create(item.Name))
                    .ToArray()
            );
        }
        catch (SecretStoreLockedException)
        {
            secrets = [];
        }
        return new JsonObject { ["servers"] = servers, ["secrets"] = secrets };
    }
}
