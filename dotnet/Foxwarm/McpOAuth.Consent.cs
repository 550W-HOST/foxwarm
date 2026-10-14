using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol;
using ModelContextProtocol.Authentication;

namespace Foxwarm;

internal sealed partial class McpOAuthService
{
    private static bool Advertises(JsonObject metadata, string key, string value) =>
        metadata[key] is JsonArray array && array.Any(item => Text(item) == value);

    private static async Task<JsonObject?> MetadataAsync(
        string resource,
        string endpoint,
        CancellationToken token
    )
    {
        var reply = await McpOAuthHttp.RequestAsync(
            resource,
            endpoint,
            HttpMethod.Get,
            null,
            null,
            token
        );
        return (int)reply.Status is >= 200 and < 300 ? reply.Body : null;
    }

    private async Task<JsonObject> DiscoverAsync(
        JsonObject config,
        string? resourceMetadataUrl,
        CancellationToken token
    )
    {
        var resourceUrl = Text(config["url"])!;
        var requested = McpOAuthHttp.Endpoint(resourceUrl);
        JsonObject? resource = null;
        var origin = requested.GetLeftPart(UriPartial.Authority);
        var candidates = resourceMetadataUrl is not null
            ? new[] { resourceMetadataUrl }
            : new[]
            {
                origin
                    + "/.well-known/oauth-protected-resource"
                    + requested.AbsolutePath.TrimEnd('/'),
                origin + "/.well-known/oauth-protected-resource",
            }.Distinct();
        foreach (var endpoint in candidates)
            if ((resource = await MetadataAsync(resourceUrl, endpoint, token)) is not null)
                break;
        if (resource is null)
            throw Error(
                "discovery",
                "The MCP server does not advertise protected-resource metadata."
            );
        var parsedResource =
            resource.Deserialize<ProtectedResourceMetadata>(McpJsonUtilities.DefaultOptions)
            ?? throw Error(
                "discovery",
                "The MCP server returned invalid protected-resource metadata."
            );
        var canonical = McpOAuthHttp.Endpoint(parsedResource.Resource);
        if (
            !McpOAuthHttp.SameOrigin(requested, canonical)
            || requested.AbsolutePath != canonical.AbsolutePath
                && !requested.AbsolutePath.StartsWith(
                    canonical.AbsolutePath.TrimEnd('/') + "/",
                    StringComparison.Ordinal
                )
            || canonical.Query.Length > 0 && canonical.Query != requested.Query
        )
            throw Error("resource", "The OAuth resource does not match this MCP server.");
        var issuer =
            parsedResource.AuthorizationServers.FirstOrDefault()
            ?? throw Error(
                "discovery",
                "The MCP server does not advertise an authorization server."
            );
        var issuerUri = McpOAuthHttp.Endpoint(issuer);
        if (issuerUri.Query.Length > 0)
            throw Error("issuer", "The authorization server advertises an invalid issuer.");
        var issuerOrigin = issuerUri.GetLeftPart(UriPartial.Authority);
        var path = issuerUri.AbsolutePath.TrimEnd('/');
        var metadataCandidates = new[]
        {
            issuerOrigin + "/.well-known/oauth-authorization-server" + path,
            issuerOrigin + "/.well-known/openid-configuration" + path,
            issuerOrigin + path + "/.well-known/openid-configuration",
        }.Distinct();
        JsonObject? metadata = null;
        foreach (var endpoint in metadataCandidates)
            if ((metadata = await MetadataAsync(resourceUrl, endpoint, token)) is not null)
                break;
        if (metadata is null || Text(metadata["issuer"]) != issuer)
            throw Error("issuer", "The authorization server metadata issuer does not match.");
        if (!Advertises(metadata, "code_challenge_methods_supported", "S256"))
            throw Error("pkce", "The authorization server must advertise PKCE S256 support.");
        McpOAuthHttp.Endpoint(Text(metadata["authorization_endpoint"]));
        McpOAuthHttp.Endpoint(Text(metadata["token_endpoint"]));
        if (metadata["registration_endpoint"] is not null)
            McpOAuthHttp.Endpoint(Text(metadata["registration_endpoint"]));
        var discovery = new JsonObject
        {
            ["authorizationServerUrl"] = issuer,
            ["resourceMetadata"] = resource,
            ["authorizationServerMetadata"] = metadata,
        };
        if (resourceMetadataUrl is not null)
            discovery["resourceMetadataUrl"] = resourceMetadataUrl;
        return discovery;
    }

    private async Task<JsonObject> RegisterAsync(
        JsonObject config,
        JsonObject discovery,
        JsonObject? retained,
        CancellationToken token
    )
    {
        if (config["oauth"]?["clientId"] is not null)
        {
            var client = new JsonObject
            {
                ["client_id"] = config["oauth"]!["clientId"]!.DeepClone(),
            };
            if (config["oauth"]?["clientSecret"] is not null)
                client["client_secret"] = config["oauth"]!["clientSecret"]!.DeepClone();
            return client;
        }
        if (retained is not null)
            return Copy(retained);
        var metadata = discovery["authorizationServerMetadata"]!.AsObject();
        var clientMetadata = ClientMetadata();
        if (
            metadata["client_id_metadata_document_supported"]?.GetValue<bool>() == true
            && Advertises(metadata, "token_endpoint_auth_methods_supported", "none")
            && new Uri(PublicUrl(ClientPath)).Scheme == "https"
        )
            return new JsonObject { ["client_id"] = PublicUrl(ClientPath) };
        var registration = Text(metadata["registration_endpoint"]);
        if (registration is null)
            throw Error(
                "client-required",
                "This server requires a pre-registered client ID. Enter client credentials in Authorizations."
            );
        clientMetadata.Remove("client_id");
        var scope = Text(config["oauth"]?["scope"]);
        if (scope is not null)
            clientMetadata["scope"] = scope;
        var reply = await McpOAuthHttp.RequestAsync(
            Text(config["url"])!,
            registration,
            HttpMethod.Post,
            new StringContent(clientMetadata.ToJsonString(), Encoding.UTF8, "application/json"),
            null,
            token
        );
        if (
            (int)reply.Status is < 200 or >= 300
            || reply.Body is not { } body
            || string.IsNullOrEmpty(Text(body["client_id"]))
            || Text(body["client_id"])!.Length > 8192
        )
            throw Error(
                "registration",
                "Client registration was rejected. Check the server settings or enter a pre-registered client ID."
            );
        // Preserve the standard registration fields in the Source-compatible record.
        _ =
            body.Deserialize<DynamicClientRegistrationResponse>(McpJsonUtilities.DefaultOptions)
            ?? throw Error("registration", "The server returned invalid client registration.");
        return body;
    }

    internal async Task<string> BeginAsync(string name, JsonObject config, CancellationToken token)
    {
        PublicUrl(CallbackPath);
        long epoch;
        lock (gate)
        {
            Prune();
            if (config["oauth"] is not JsonObject || config["enable"]?.GetValue<bool>() == false)
                throw Error(
                    "configuration",
                    "Configure OAuth on an enabled HTTP MCP server first."
                );
            if (starting.Contains(name))
                throw Error("pending", "Authorization is already starting for this server.");
            if (flows.Count + starting.Count >= 32)
                throw Error(
                    "pending",
                    "Too many pending authorizations. Finish one or try again later."
                );
            epoch = Epoch(name);
            Current(name, config, epoch);
            starting.Add(name);
        }
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown);
        try
        {
            var challenge = await McpOAuthHttp.ProbeAsync(Text(config["url"])!, lifetime.Token);
            var discovery = await DiscoverAsync(
                config,
                McpOAuthHttp.Challenge(challenge, "resource_metadata"),
                lifetime.Token
            );
            JsonObject? retained;
            bool reuse;
            lock (gate)
            {
                Current(name, config, epoch);
                var previous = Load()[name] as JsonObject;
                reuse =
                    Matches(previous, config)
                    && Text(previous?["discovery"]?["authorizationServerUrl"])
                        == Text(discovery["authorizationServerUrl"])
                    && Text(previous?["discovery"]?["resourceMetadata"]?["resource"])
                        == Text(discovery["resourceMetadata"]?["resource"]);
                if (!reuse && previous?["tokens"] is not null)
                {
                    Disconnect(name);
                    epoch = Epoch(name);
                }
                retained = reuse ? previous?["clientInformation"] as JsonObject : null;
            }
            var client = await RegisterAsync(config, discovery, retained, lifetime.Token);
            var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
            var grant = new JsonObject
            {
                ["serverUrl"] = config["url"]!.DeepClone(),
                ["publicBaseUrl"] = publicBaseUrl,
                ["settings"] = Settings(config),
                ["discovery"] = discovery,
                ["clientInformation"] = client,
            };
            lock (gate)
            {
                Current(name, config, epoch);
                var live = Load()[name] as JsonObject;
                var scope =
                    SafeScope(McpOAuthHttp.Challenge(challenge, "scope"))
                    ?? (reuse ? Text(live?["requiredScope"]) : null);
                if (scope is not null)
                    grant["requiredScope"] = scope;
                var parameters = new Dictionary<string, string>
                {
                    ["response_type"] = "code",
                    ["client_id"] = Text(client["client_id"])!,
                    ["redirect_uri"] = PublicUrl(CallbackPath),
                    ["state"] = state,
                    ["code_challenge"] = Base64Url(
                        SHA256.HashData(Encoding.ASCII.GetBytes(verifier))
                    ),
                    ["code_challenge_method"] = "S256",
                    ["resource"] = Text(discovery["resourceMetadata"]?["resource"])!,
                };
                var requestedScope = UnionScopes(Text(config["oauth"]?["scope"]), scope);
                if (requestedScope is not null)
                    parameters["scope"] = requestedScope;
                var endpoint = Text(
                    discovery["authorizationServerMetadata"]?["authorization_endpoint"]
                )!;
                var authorizationUrl =
                    endpoint
                    + (endpoint.Contains('?') ? "&" : "?")
                    + McpOAuthHttp.Query(parameters);
                // Merge into live authority, not the pre-discovery token snapshot.
                var next = reuse && live is not null ? Copy(live) : Copy(grant);
                next["discovery"] = discovery.DeepClone();
                next["clientInformation"] = client.DeepClone();
                Save(name, next);
                ClearFlows(name);
                flows[state] = new(name, Copy(config), epoch, Now, state, verifier, grant);
                return authorizationUrl;
            }
        }
        catch (Exception error)
        {
            throw SafeError(error);
        }
        finally
        {
            lock (gate)
                starting.Remove(name);
        }
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal async Task FinishAsync(JsonObject query, CancellationToken token)
    {
        Flow flow;
        lock (gate)
        {
            Prune();
            var state = Text(query["state"]) ?? "";
            if (!flows.TryGetValue(state, out flow!))
                throw Error(
                    "callback",
                    "Authorization has expired or the callback is invalid. Start again."
                );
            var issuer = Text(query["iss"]);
            if (
                query.ContainsKey("iss")
                    && issuer != Text(flow.Grant["discovery"]?["authorizationServerUrl"])
                || flow.Grant["discovery"]
                    ?["authorizationServerMetadata"]?[
                        "authorization_response_iss_parameter_supported"
                    ]?.GetValue<bool>() == true
                    && issuer is null
            )
                throw Error("issuer", "The authorization callback issuer does not match.");
            var code = Text(query["code"]);
            flows.Remove(state); // Single-use before exchange, including cancellation or rejection.
            if (string.IsNullOrEmpty(code) || code.Length > 8192 || query.ContainsKey("error"))
                throw Error("callback", "Authorization was not completed. Start again when ready.");
            Current(flow.Server, flow.Config, flow.Epoch);
        }
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown);
        try
        {
            var tokens = await TokenRequestAsync(
                flow.Config,
                flow.Grant,
                new Dictionary<string, string>
                {
                    ["grant_type"] = "authorization_code",
                    ["code"] = Text(query["code"])!,
                    ["redirect_uri"] = PublicUrl(CallbackPath),
                    ["code_verifier"] = flow.Verifier,
                    ["resource"] = Text(flow.Grant["discovery"]?["resourceMetadata"]?["resource"])!,
                },
                lifetime.Token
            );
            lock (gate)
            {
                Current(flow.Server, flow.Config, flow.Epoch);
                try
                {
                    Save(flow.Server, WithTokens(flow.Grant, tokens));
                }
                catch (AuthorityCommittedException)
                {
                    epochs[flow.Server] = flow.Epoch + 1;
                    ClearFlows(flow.Server);
                    closeConnections(flow.Server);
                    throw;
                }
                epochs[flow.Server] = flow.Epoch + 1;
                ClearFlows(flow.Server);
            }
            closeConnections(flow.Server);
        }
        catch (Exception error)
        {
            throw SafeError(error);
        }
    }

    private async Task<JsonObject> TokenRequestAsync(
        JsonObject config,
        JsonObject grant,
        Dictionary<string, string> fields,
        CancellationToken token
    )
    {
        var client = config["oauth"]?["clientId"] is not null
            ? new JsonObject
            {
                ["client_id"] = config["oauth"]!["clientId"]!.DeepClone(),
                ["client_secret"] = config["oauth"]?["clientSecret"]?.DeepClone(),
            }
            : grant["clientInformation"]!.AsObject();
        var metadata = grant["discovery"]!["authorizationServerMetadata"]!.AsObject();
        var clientId = Text(client["client_id"])!;
        var secret = Text(client["client_secret"]);
        string? authorization = null;
        var registeredMethod = Text(client["token_endpoint_auth_method"]);
        var method =
            registeredMethod is "none" or "client_secret_basic" or "client_secret_post"
            && Advertises(metadata, "token_endpoint_auth_methods_supported", registeredMethod)
                ? registeredMethod
            : secret is not null
            && Advertises(metadata, "token_endpoint_auth_methods_supported", "client_secret_basic")
                ? "client_secret_basic"
            : secret is not null ? "client_secret_post"
            : "none";
        if (method == "client_secret_basic")
        {
            if (secret is null)
                throw Error(
                    "credentials",
                    "Client credentials were rejected. Check them in Authorizations."
                );
            authorization =
                "Basic "
                + Convert.ToBase64String(
                    Encoding.UTF8.GetBytes(
                        WebUtility.UrlEncode(clientId) + ":" + WebUtility.UrlEncode(secret)
                    )
                );
        }
        else
        {
            fields["client_id"] = clientId;
            if (method == "client_secret_post" && secret is not null)
                fields["client_secret"] = secret;
        }
        Remember(secret, Text(grant["tokens"]?["refresh_token"]));
        var reply = await McpOAuthHttp.RequestAsync(
            Text(config["url"])!,
            Text(metadata["token_endpoint"])!,
            HttpMethod.Post,
            new FormUrlEncodedContent(fields),
            authorization,
            token
        );
        if ((int)reply.Status is < 200 or >= 300)
        {
            var code = Text(reply.Body?["error"]);
            throw code switch
            {
                "invalid_grant" => Error(
                    "invalid_grant",
                    "Authorization expired or was revoked. Authorize again."
                ),
                "invalid_client" or "unauthorized_client" => Error(
                    "invalid_client",
                    "Client credentials were rejected. Check them in Authorizations."
                ),
                _ => Error(
                    "token",
                    "Authorization credentials could not be renewed. Check the server connection and settings."
                ),
            };
        }
        var body =
            reply.Body ?? throw Error("token", "The server returned unsupported credentials.");
        return body;
    }

    private static JsonObject WithTokens(JsonObject grant, JsonObject tokens)
    {
        var access = Text(tokens["access_token"]);
        var expires = SessionWait.Number(tokens["expires_in"]);
        if (
            Text(tokens["token_type"])?.Equals("Bearer", StringComparison.OrdinalIgnoreCase) != true
            || string.IsNullOrEmpty(access)
            || !System.Text.RegularExpressions.Regex.IsMatch(access, "^[A-Za-z0-9._~+/-]+=*$")
            || tokens.ContainsKey("expires_in")
                && (expires is null || !double.IsFinite(expires.Value) || expires <= 0)
            || tokens.ContainsKey("refresh_token")
                && string.IsNullOrEmpty(Text(tokens["refresh_token"]))
            || tokens.ContainsKey("scope") && SafeScope(Text(tokens["scope"])) is null
        )
            throw Error("token", "The server returned unsupported credentials.");
        var next = Copy(grant);
        var persisted = Copy(tokens);
        if (!persisted.ContainsKey("scope") && grant["tokens"]?["scope"] is not null)
            persisted["scope"] = grant["tokens"]!["scope"]!.DeepClone();
        next["tokens"] = persisted;
        if (expires is not null)
            next["expiresAt"] = Now + expires.Value * 1000;
        else
            next.Remove("expiresAt");
        next.Remove("requiredScope");
        next.Remove("error");
        return next;
    }
}
