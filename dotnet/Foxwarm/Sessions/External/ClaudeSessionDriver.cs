using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed class ClaudeRuntimeException(string message) : IOException(message);

// One trusted Main-local CLI run for one committed input. The Session processor owns its lifetime.
internal sealed class ClaudeSessionDriver(SessionManager manager, SessionOwner owner, LocalSessionTurnHost host)
{
    private readonly HashSet<string> observed = new(StringComparer.Ordinal);
    private readonly StringBuilder text = new();
    private readonly StringBuilder reasoning = new();
    private JsonObject checkpoint = new();
    private JsonObject? lastAssistant;
    private string? stream;

    internal async Task<ChatResult> RunAsync(CancellationToken token)
    {
        if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException("Claude Code Session hosting currently requires Linux.");
        var endpoint = manager.RuntimeMcpEndpoint ?? throw new ClaudeRuntimeException("Runtime MCP endpoint is unavailable; start the Main HTTP listener first.");
        var config = ClaudeRuntimeConfiguration.Capture(manager.Models.ConfigurationOwner?.AppConfiguration);
        var snapshot = owner.Entry.Snapshot();
        checkpoint = (JsonObject)(snapshot.AuthorityEnvelope["externalRuntime"]?.DeepClone() ?? new JsonObject { ["status"] = "new" });
        var previousCheckpoint = (JsonObject)checkpoint.DeepClone();
        var resume = SessionWait.Text(checkpoint["sessionId"]);
        var cwd = SessionWait.Text(checkpoint["cwd"]) ?? config.WorkingDirectory ?? manager.AgentDirectory(owner.Agent);
        if (!Directory.Exists(cwd)) throw new ClaudeRuntimeException("Claude Code Main-local working directory does not exist.");
        if (resume is not null && (SessionWait.Text(checkpoint["transcript"]) is not string transcript || !File.Exists(transcript)))
            throw new ClaudeRuntimeException("Claude Code transcript is unavailable. Restore its Main-local transcript or Clear this Session; the previous input will not be replayed.");
        var externalId = resume ?? Guid.NewGuid().ToString();
        checkpoint["sessionId"] = externalId;
        checkpoint["cwd"] = cwd;
        checkpoint["transcript"] ??= TranscriptPath(cwd, externalId);
        var frontier = SessionWait.Number(checkpoint["submittedThroughSeq"]) ?? 0;
        var messages = snapshot.History.Materialize().Where(row => (SessionWait.Number(row["__meta"]?["seq"]) ?? 0) > frontier && SessionWait.Text(row["role"]) == "user").ToArray();
        var inputParts = new List<JsonObject>();
        if (messages.Length > 0)
        {
            var hydrated = await manager.Images.HydrateAsync(messages, "anthropic", token: token);
            foreach (var row in hydrated)
                foreach (var part in (row["parts"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    if (SessionWait.Text(part["text"] ?? part["system"]) is { } value) inputParts.Add(new() { ["type"] = "text", ["text"] = value });
                    if (part["inlineData"] is JsonObject inline) inputParts.Add(new() { ["type"] = "image", ["source"] = new JsonObject { ["type"] = "base64", ["media_type"] = inline["mimeType"]?.DeepClone(), ["data"] = inline["data"]?.DeepClone() } });
                }
        }
        if (inputParts.Count == 0)
        {
            if (!ClaudeRuntimeState.Interrupted(snapshot.AuthorityEnvelope)) throw new ClaudeRuntimeException("No unsubmitted input is available.");
            // Continue is new explicit input, never a replay of a possibly accepted message.
            inputParts.Add(new() { ["type"] = "text", ["text"] = "Continue from the existing conversation. The prior input may already have been processed; do not repeat completed tool effects." });
        }
        checkpoint["submittedThroughSeq"] ??= 0;
        checkpoint["status"] = "running";
        await host.AppendHistoryMessageStrictAsync(null, externalRuntime: checkpoint);
        Process? process = null;
        ClaudeRuntimeRun? run = null;
        run = manager.RuntimeCredentials.Issue(owner, config.CredentialLifetime, () => manager.Accepting && manager.Find(owner.Id) == owner && owner.Entry.HasProcessor && owner.Entry.WithState(s => s.Busy && !s.Stopping) && !owner.Registry.Runner.Closing && ReferenceEquals(host.RuntimeTools.ExternalRun, run));
        host.RuntimeTools.ExternalRun = run;
        run.Call = async (name, args, requestToken) =>
        {
            await run.Lane.WaitAsync(requestToken);
            try
            {
                run.Require();
                return await host.ExecuteRuntimeToolAsync(new JsonObject { ["id"] = "runtime-" + Guid.NewGuid().ToString("N"), ["name"] = name, ["args"] = args.DeepClone() }, requestToken);
            }
            finally { run.Lane.Release(); }
        };
        var runDirectory = Path.Combine(manager.DataRoot, "state", "runtime-runs", run.Id);
        using var cancellation = token.Register(run.Revoke);
        using var identityCancellation = owner.Entry.IdentityLossToken.Register(run.Revoke);
        using var renewalStop = new CancellationTokenSource();
        Task? stderr = null;
        var inputMayBeAccepted = false;
        var renewal = RenewAsync(run, config.CredentialLifetime, renewalStop.Token);
        try
        {
            run.Require();
            Directory.CreateDirectory(runDirectory);
            File.SetUnixFileMode(runDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var mcpFile = Path.Combine(runDirectory, "mcp.json");
            var settingsFile = Path.Combine(runDirectory, "settings.json");
            var promptFile = Path.Combine(runDirectory, "instructions.md");
            await PrivateFileAsync(mcpFile, new JsonObject { ["mcpServers"] = new JsonObject { ["foxwarm"] = new JsonObject { ["type"] = "http", ["url"] = endpoint.AbsoluteUri, ["headers"] = new JsonObject { ["Authorization"] = "Bearer " + run.Token } } } }.ToJsonString());
            await PrivateFileAsync(settingsFile, new JsonObject { ["disableAllHooks"] = true, ["autoMemoryEnabled"] = false, ["disableBundledSkills"] = true, ["disableSkillShellExecution"] = true, ["permissions"] = new JsonObject { ["defaultMode"] = "dontAsk" } }.ToJsonString());
            await PrivateFileAsync(promptFile, SessionWait.Text(snapshot.AuthorityEnvelope["persistentMemorySnapshot"]) ?? "");
            var start = Command(config.Executable, cwd, mcpFile, settingsFile, promptFile, resume, externalId);
            process = new Process { StartInfo = start };
            if (!process.Start()) throw new ClaudeRuntimeException("Claude Code process could not be started.");
            // Drain without logging user/account data. Errors are reported by structured results or exit status.
            run.ChildAlive = () => !process.HasExited;
            stderr = DrainAsync(process.StandardError);
            stream = owner.BeginDraft(externalRuntime: true);
            using var stopProcess = run.Cancellation.Token.Register(() => Interrupt(process));
            var input = new JsonObject { ["type"] = "user", ["session_id"] = externalId, ["message"] = new JsonObject { ["role"] = "user", ["content"] = new JsonArray(inputParts.Select(p => (JsonNode)p).ToArray()) }, ["parent_tool_use_id"] = null };
            checkpoint["submittedThroughSeq"] = snapshot.NextMessageSeq - 1;
            await host.AppendHistoryMessageStrictAsync(null, externalRuntime: checkpoint);
            inputMayBeAccepted = true;
            await process.StandardInput.WriteLineAsync(input.ToJsonString());
            await process.StandardInput.FlushAsync();
            process.StandardInput.Close();
            var resultSeen = false;
            var reader = new NdjsonReader(process.StandardOutput);
            while (await reader.ReadAsync(run.Cancellation.Token) is { } line)
            {
                if (line.Length == 0) continue;
                if (JsonNode.Parse(line) is not JsonObject message) throw new ClaudeRuntimeException("Claude Code emitted an invalid NDJSON event.");
                if (SessionWait.Text(message["session_id"]) is { } reported && reported != externalId) throw new ClaudeRuntimeException("Claude Code reported a different external Session ID.");
                await run.Lane.WaitAsync(run.Cancellation.Token);
                try
                {
                    run.RequireObservation();
                    if (SessionWait.Text(message["type"]) == "result")
                    {
                        resultSeen = true;
                        // Fence admission before result publication and process termination.
                        manager.RuntimeCredentials.Retire(run);
                        await CompleteAsync(message);
                        break;
                    }
                    await ObserveAsync(message);
                }
                finally { run.Lane.Release(); }
            }
            if (!resultSeen) throw new ClaudeRuntimeException("Claude Code ended without a result. The input outcome is unknown and will not be replayed automatically.");
            await StopProcessAsync(process);
            return new ChatResult(lastAssistant) { Terminal = false };
        }
        catch
        {
            manager.RuntimeCredentials.Retire(run);
            if (process is not null) await StopProcessAsync(process);
            // Join admitted tool effects before publishing interruption or releasing the processor.
            await run.Lane.WaitAsync();
            try
            {
                if (text.Length > 0 || reasoning.Length > 0)
                {
                    var partial = new JsonArray();
                    if (reasoning.Length > 0) partial.Add(new JsonObject { ["text"] = reasoning.ToString(), ["thinking"] = true });
                    if (text.Length > 0) partial.Add(new JsonObject { ["text"] = text.ToString() });
                    await AssistantAsync(partial, incomplete: true);
                }
                if (inputMayBeAccepted) checkpoint["status"] = "interrupted";
                else checkpoint = previousCheckpoint;
                await host.AppendHistoryMessageStrictAsync(null, externalRuntime: checkpoint);
            }
            finally { run.Lane.Release(); }
            token.ThrowIfCancellationRequested();
            throw;
        }
        finally
        {
            manager.RuntimeCredentials.Retire(run);
            owner.ClearDraft();
            renewalStop.Cancel();
            await renewal;
            if (process is not null)
            {
                await StopProcessAsync(process);
                if (stderr is not null) await stderr;
                process.Dispose();
            }
            await run.Lane.WaitAsync();
            try { host.RuntimeTools.ExternalRun = null; run.Call = null; }
            finally { run.Lane.Release(); }
            // No token/config survives the run; the CLI's own account and transcript are not touched.
            if (Directory.Exists(runDirectory)) Directory.Delete(runDirectory, recursive: true);
        }
    }

    private async Task ObserveAsync(JsonObject message)
    {
        var type = SessionWait.Text(message["type"]);
        var subtype = SessionWait.Text(message["subtype"]);
        if (type == "system" && subtype == "init")
        {
            ValidateInit(message);
            if (SessionWait.Text(message["model"]) is { } model) checkpoint["model"] = model;
            if (SessionWait.Text(message["apiKeySource"] ?? message["authMethod"]) is { } auth) checkpoint["authMethod"] = auth;
            await host.AppendHistoryMessageStrictAsync(null, externalRuntime: checkpoint);
        }
        if (type == "stream_event" && message["parent_tool_use_id"] is null)
        {
            if (owner.DraftSnapshot().Count == 0) stream = owner.BeginDraft(externalRuntime: true);
            var delta = message["event"]?["delta"];
            if (SessionWait.Text(delta?["type"]) == "text_delta") text.Append(SessionWait.Text(delta?["text"]));
            if (SessionWait.Text(delta?["type"]) == "thinking_delta") reasoning.Append(SessionWait.Text(delta?["thinking"]));
            owner.PublishDraftProgress(new(reasoning.ToString(), text.ToString(), []));
        }
        if (type == "assistant" && message["parent_tool_use_id"] is null)
        {
            var id = SessionWait.Text(message["uuid"] ?? message["message"]?["id"]);
            if (id is not null && !observed.Add(id)) return;
            var parts = new JsonArray();
            foreach (var content in (message["message"]?["content"] as JsonArray ?? []).OfType<JsonObject>())
            {
                if (SessionWait.Text(content["type"]) == "text" && SessionWait.Text(content["text"]) is { Length: > 0 } value) parts.Add(new JsonObject { ["text"] = value });
                if (SessionWait.Text(content["type"]) == "thinking" && SessionWait.Text(content["thinking"]) is { } thought) parts.Add(new JsonObject { ["text"] = thought, ["thinking"] = true });
                if (SessionWait.Text(content["type"]) == "tool_use") await ObservationAsync("tool_use", new JsonObject { ["name"] = content["name"]?.DeepClone(), ["id"] = content["id"]?.DeepClone() });
            }
            if (parts.Count > 0) await AssistantAsync(parts);
        }
        if (type == "system" && subtype is "compact_boundary" or "microcompact_boundary") await ObservationAsync("compaction", message["compact_metadata"] as JsonObject ?? new JsonObject());
        if (type == "user" && message["parent_tool_use_id"] is null && (message["message"]?["content"] as JsonArray)?.OfType<JsonObject>().Any(c => SessionWait.Text(c["type"]) == "tool_result") == true)
            await ObservationAsync("tool_result", new JsonObject());
    }

    private async Task AssistantAsync(JsonArray parts, bool incomplete = false)
    {
        var row = new JsonObject { ["role"] = "model", ["parts"] = parts, ["__meta"] = new JsonObject { ["runtime"] = ClaudeRuntimeState.Kind, ["runtimeStreamId"] = stream, ["runtimePartial"] = incomplete } };
        lastAssistant = (await host.AppendHistoryMessageStrictAsync(row))[^1];
        if (owner.Entry.AssistantCommitted is { } present) await present(lastAssistant);
        text.Clear();
        reasoning.Clear();
    }
    private async Task ObservationAsync(string kind, JsonObject detail)
    {
        await host.AppendHistoryMessageStrictAsync(new JsonObject { ["role"] = "model", ["modelVisible"] = false, ["parts"] = new JsonArray(new JsonObject { ["text"] = "Claude Code " + kind }), ["__meta"] = new JsonObject { ["runtimeObservation"] = kind, ["detail"] = detail.DeepClone() } });
    }
    private async Task CompleteAsync(JsonObject result)
    {
        if (result["is_error"]?.GetValue<bool>() == true || SessionWait.Text(result["subtype"]) is { } subtype && subtype != "success")
            throw new ClaudeRuntimeException("Claude Code reported a failed result; its input and tool outcomes will not be replayed automatically.");
        if (lastAssistant is null && SessionWait.Text(result["result"]) is { Length: > 0 } final) await AssistantAsync(new JsonArray(new JsonObject { ["text"] = final }));
        var usage = new JsonObject { ["source"] = ClaudeRuntimeState.Kind };
        foreach (var key in new[] { "usage", "modelUsage", "total_cost_usd", "duration_ms", "duration_api_ms", "num_turns", "stop_reason" })
            if (result.ContainsKey(key)) usage[key] = result[key]?.DeepClone();
        // CLI cost may be cumulative across resume; preserve its latest estimate without adding it to API cost.
        if (lastAssistant is not null) await host.FinalizeAssistantControlsAsync(lastAssistant);
        checkpoint["lastResult"] = usage;
        checkpoint["status"] = "complete";
        await host.AppendHistoryMessageStrictAsync(null, externalRuntime: checkpoint);
    }

    internal static void ValidateInit(JsonObject message)
    {
        var names = (message["tools"] as JsonArray ?? []).Select(SessionWait.Text).ToArray();
        if (names.Any(n => n is not ("mcp__foxwarm__search_tools" or "mcp__foxwarm__call_tool" or "EndConversation")) || !names.Contains("mcp__foxwarm__call_tool"))
            throw new ClaudeRuntimeException("Claude Code did not report the required MCP-only tool set.");
        var servers = (message["mcp_servers"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
        if (!names.Contains("mcp__foxwarm__search_tools") || servers.Length != 1 || SessionWait.Text(servers[0]["name"]) != "foxwarm" || SessionWait.Text(servers[0]["status"]) != "connected" || (message["plugins"] as JsonArray)?.Count > 0 || (message["mcp_server_errors"] as JsonArray)?.Count > 0 || SessionWait.Text(message["permissionMode"]) is { } mode && mode != "dontAsk")
            throw new ClaudeRuntimeException("Claude Code configuration loaded unsupported plugins or MCP servers. Review its managed configuration before retrying.");
    }

    internal static ProcessStartInfo Command(string executable, string cwd, string mcp, string settings, string prompt, string? resume, string id)
    {
        var start = new ProcessStartInfo("setsid") { WorkingDirectory = cwd, UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false, true) };
        start.ArgumentList.Add("--wait");
        start.ArgumentList.Add("--");
        start.ArgumentList.Add(executable);
        foreach (var arg in new[] { "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config", mcp, "--allowedTools", "mcp__foxwarm__*", "--permission-prompts", "none", "--permission-mode", "dontAsk", "--disable-slash-commands", "--settings", settings, "--append-system-prompt-file", prompt }) start.ArgumentList.Add(arg);
        start.ArgumentList.Add(resume is null ? "--session-id" : "--resume"); start.ArgumentList.Add(resume ?? id);
        // Deliberately inherit normal account authentication/model configuration, with no LLM overrides.
        return start;
    }
    internal static string TranscriptPath(string cwd, string id)
    {
        var config = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
        return Path.Combine(config, "projects", Regex.Replace(cwd, "[^a-zA-Z0-9]", "-"), id + ".jsonl");
    }
    private static async Task PrivateFileAsync(string path, string value)
    {
        if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException();
        await using var file = new FileStream(path, new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite });
        await file.WriteAsync(Encoding.UTF8.GetBytes(value));
    }
    private static async Task RenewAsync(ClaudeRuntimeRun run, TimeSpan lifetime, CancellationToken token)
    {
        try { while (true) { await Task.Delay(lifetime / 3, token); if (!run.Renew()) { if (run.ChildAlive?.Invoke() != false) run.Revoke(); return; } } }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }
    private sealed class NdjsonReader(StreamReader reader)
    {
        private readonly char[] buffer = new char[8192];
        private int offset;
        private int length;
        internal async Task<string?> ReadAsync(CancellationToken token)
        {
            var line = new StringBuilder();
            while (true)
            {
                if (offset == length)
                {
                    length = await reader.ReadAsync(buffer.AsMemory(), token);
                    offset = 0;
                    if (length == 0)
                    {
                        if (line.Length > 0) throw new ClaudeRuntimeException("Claude Code ended with an incomplete NDJSON record.");
                        return null;
                    }
                }
                var end = Array.IndexOf(buffer, '\n', offset, length - offset);
                var count = (end < 0 ? length : end) - offset;
                if (line.Length + count > 8 * 1024 * 1024) throw new ClaudeRuntimeException("Claude Code NDJSON record exceeded the input limit.");
                line.Append(buffer, offset, count);
                offset += count;
                if (end >= 0) { offset++; return line.ToString().TrimEnd('\r'); }
            }
        }
    }
    private static async Task DrainAsync(StreamReader reader) { var buffer = new char[4096]; while (await reader.ReadAsync(buffer) > 0) { } }
    [DllImport("libc", SetLastError = true)] private static extern int kill(int pid, int signal);
    private static void Interrupt(Process process) { try { if (kill(-process.Id, 2) < 0 && !process.HasExited) _ = kill(process.Id, 2); } catch (InvalidOperationException) { } }
    private static async Task StopProcessAsync(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                Interrupt(process);
                try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); }
                catch (TimeoutException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
            }
        }
        catch (InvalidOperationException) { }
        finally { try { _ = kill(-process.Id, 9); } catch (InvalidOperationException) { } }
    }
}
