using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

// Installation-relative settings are captured at entry, never inferred by walking
// the shell's current directory or searching for another installation's state.
internal sealed record HostPaths(
    string ApplicationRoot,
    string ResourceRoot,
    string DataRoot,
    string ConfigPath,
    string AgentsRoot,
    string SkillsRoot,
    string McpConfigPath,
    string? LegacyWorkspace = null
)
{
    internal string ModelsPath => Path.Combine(DataRoot, "state", "models.yaml");
    internal string WorkspaceRoot => LegacyWorkspace ?? AgentsRoot;

    internal static HostPaths Capture(
        string? applicationRoot = null,
        string? resourceRoot = null,
        Func<string, string?>? environment = null
    )
    {
        var env = environment ?? Environment.GetEnvironmentVariable;
        var resources = Path.GetFullPath(resourceRoot ?? AppContext.BaseDirectory);
        var app = Path.GetFullPath(applicationRoot ?? env("FOXWARM_APP_ROOT") ?? resources);
        var selected = Nonblank(env("FOXWARM_DATA_DIR"));
        // Retained console automation may still select its original experiment data.
        selected ??= Nonblank(env("FOXWARM_EXPERIMENT_DATA_ROOT"));
        var pointer = Path.Combine(app, "data_dir");
        selected ??= File.Exists(pointer) ? Nonblank(File.ReadAllText(pointer)) : null;
        var data = selected is null ? app : Resolve(selected, app, (env("HOME") ?? ""));
        return ForDataRoot(data, app, resources, env) with
        {
            LegacyWorkspace = Nonblank(env("FOXWARM_EXPERIMENT_TOOL_ROOT")) is { } legacy
                ? Resolve(legacy, app, (env("HOME") ?? ""))
                : null,
        };
    }

    internal static HostPaths ForDataRoot(
        string dataRoot,
        string? applicationRoot = null,
        string? resourceRoot = null,
        Func<string, string?>? environment = null
    )
    {
        var env = environment ?? Environment.GetEnvironmentVariable;
        var resources = Path.GetFullPath(resourceRoot ?? AppContext.BaseDirectory);
        var app = Path.GetFullPath(applicationRoot ?? resources);
        var data = Resolve(dataRoot, app, (env("HOME") ?? ""));
        var config = env("FOXWARM_CONFIG_PATH");
        if (string.IsNullOrEmpty(config))
            config = env("CONFIG_PATH");
        return new(
            app,
            resources,
            data,
            string.IsNullOrEmpty(config)
                ? Path.Combine(data, "state", "config.yaml")
                : Path.GetFullPath(config, app),
            Path.Combine(data, "agents"),
            Path.Combine(app, "skills"),
            Path.Combine(data, "state", "mcp.json")
        );
    }

    internal HostPaths WithConfiguration(JsonObject app, Func<string, string?>? environment = null)
    {
        var env = environment ?? Environment.GetEnvironmentVariable;
        string Configured(string key, string fallback) =>
            SessionWait.Text(app["paths"]?[key]) is { Length: > 0 } value
                ? Resolve(value, ApplicationRoot, (env("HOME") ?? ""))
                : fallback;
        return this with
        {
            AgentsRoot = Configured("agentsDir", AgentsRoot),
            SkillsRoot = Nonblank(env("FOXWARM_EXPERIMENT_SKILLS_ROOT")) is { } skills
                ? Resolve(skills, ApplicationRoot, (env("HOME") ?? ""))
                : Configured("skillsDir", SkillsRoot),
            McpConfigPath = env("MCP_CONFIG_PATH") is { Length: > 0 } mcp
                ? Resolve(mcp, ApplicationRoot, (env("HOME") ?? ""))
                : Configured("mcpConfigPath", McpConfigPath),
        };
    }

    internal static string Resolve(string value, string applicationRoot, string? home = null)
    {
        value = value.Trim();
        home ??= Environment.GetEnvironmentVariable("HOME");
        if (!string.IsNullOrEmpty(home))
        {
            if (value == "~")
                value = home;
            else if (value.StartsWith("~/", StringComparison.Ordinal))
                value = Path.Combine(home, value[2..]);
        }
        return Path.GetFullPath(value, applicationRoot);
    }

    private static string? Nonblank(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
