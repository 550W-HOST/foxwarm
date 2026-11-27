using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm;

/// <summary>
/// The Desktop hosts' instances: the local instance, whose Main runs inside the app, and the
/// remote instances the user added by URL, for which the app is only a browser shell. The
/// host owns the list and the selection in its settings file in the Desktop data directory,
/// outside Main's configuration. Pages can neither read nor change it.
/// </summary>
internal sealed class DesktopInstances
{
    internal const string FileName = "desktop-settings.json";
    private const string Local = "local";
    private readonly string? path;
    private readonly List<Uri> remotes = [];

    private DesktopInstances(string? path) => this.path = path;

    /// <summary>Remote instances in the order they were added, each normalized by <see cref="Normalize"/>.</summary>
    internal IReadOnlyList<Uri> Remotes => remotes;

    /// <summary>The selected remote, or null when the local instance is selected.</summary>
    internal Uri? Selected { get; private set; }

    /// <summary>
    /// Reads the settings file in a Desktop data directory. A missing or unreadable file
    /// selects the local instance with no remotes; invalid entries are skipped.
    /// </summary>
    internal static DesktopInstances Load(string dataRoot)
    {
        var instances = new DesktopInstances(Path.Combine(dataRoot, FileName));
        try
        {
            instances.Read(File.ReadAllText(instances.path!));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Missing or unreadable: the defaults.
        }
        return instances;
    }

    /// <summary>Settings parsed from text, without a file (tests).</summary>
    internal static DesktopInstances Parse(string json)
    {
        var instances = new DesktopInstances(null);
        instances.Read(json);
        return instances;
    }

    private void Read(string json)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return;
        }
        if (root is not JsonObject settings)
            return;
        if (settings["remotes"] is JsonArray list)
            foreach (var item in list)
                if (
                    item is JsonObject remote
                    && remote["url"] is JsonValue value
                    && value.TryGetValue<string>(out var text)
                    && Normalize(text) is { } url
                    && !remotes.Contains(url)
                )
                    remotes.Add(url);
        if (
            settings["selected"] is JsonValue selected
            && selected.TryGetValue<string>(out var choice)
            && choice != Local
            && Normalize(choice) is { } chosen
        )
            Selected = remotes.FirstOrDefault(remote => remote == chosen);
    }

    internal string ToJson()
    {
        var list = new JsonArray();
        foreach (var remote in remotes)
            list.Add((JsonNode)new JsonObject { ["url"] = remote.AbsoluteUri });
        return new JsonObject
        {
            ["selected"] = Selected?.AbsoluteUri ?? Local,
            ["remotes"] = list,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    /// <summary>Selects a remote of the list, or the local instance for null.</summary>
    internal void Select(Uri? remote)
    {
        Selected = remote is null ? null : remotes.FirstOrDefault(item => item == remote);
        Save();
    }

    /// <summary>Adds a remote (or finds the same one already listed) and returns the listed URL.</summary>
    internal Uri Add(Uri url)
    {
        var normalized = Normalize(url.AbsoluteUri) ?? throw new ArgumentException("Not an instance URL.", nameof(url));
        var existing = remotes.FirstOrDefault(remote => remote == normalized);
        if (existing is not null)
            return existing;
        remotes.Add(normalized);
        Save();
        return normalized;
    }

    /// <summary>Removes a remote; removing the selected one selects the local instance.</summary>
    internal void Remove(Uri url)
    {
        if (!remotes.Remove(url))
            return;
        if (Selected == url)
            Selected = null;
        Save();
    }

    private void Save()
    {
        if (path is null)
            return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, ToJson());
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The change still applies to this run.
            Console.Error.WriteLine("Desktop settings could not be saved: " + error.Message);
        }
    }

    /// <summary>
    /// The instance URL for what the user typed: an absolute HTTP(S) URL without user
    /// information, query or fragment, whose path is the instance's base path and ends with
    /// <c>/</c>. Without a scheme, local-looking hosts (localhost, IP addresses, names without
    /// a dot) get <c>http://</c> and others <c>https://</c>. Null for anything else.
    /// </summary>
    internal static Uri? Normalize(string? input)
    {
        var text = input?.Trim();
        if (string.IsNullOrEmpty(text))
            return null;
        if (!text.Contains("://", StringComparison.Ordinal))
            text = (LooksLocal(text) ? "http://" : "https://") + text;
        if (
            !Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.IsNullOrEmpty(uri.Host)
            || uri.UserInfo.Length > 0
        )
            return null;
        var basePath = uri.AbsolutePath.EndsWith('/') ? uri.AbsolutePath : uri.AbsolutePath + "/";
        return new Uri(uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped) + basePath);
    }

    private static bool LooksLocal(string text)
    {
        var end = text.IndexOfAny(['/', '?', '#']);
        var authority = end < 0 ? text : text[..end];
        if (authority.StartsWith('['))
            return true;
        var colon = authority.LastIndexOf(':');
        var host = colon < 0 ? authority : authority[..colon];
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || System.Net.IPAddress.TryParse(host, out _)
            || !host.Contains('.');
    }

    /// <summary>
    /// The stop confirmation's detail. Stopping interrupts running turns; Main's startup
    /// recovery resumes them the next time the local instance starts.
    /// </summary>
    internal static string RunningSessionsText(int running) =>
        running switch
        {
            <= 0 => "No Sessions are running.",
            1 => "1 Session is running. It pauses now and continues when the local instance starts again.",
            _ => running.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " Sessions are running. They pause now and continue when the local instance starts again.",
        };

    /// <summary>The menu's name for a remote: its host, port and base path, as typed.</summary>
    internal static string Label(Uri url)
    {
        var basePath = Uri.UnescapeDataString(url.AbsolutePath).TrimEnd('/');
        return url.Authority + basePath;
    }
}

/// <summary>
/// The brand row's request to open the host's instance menu:
/// <c>{ "type": "instance-menu", "anchor": [x, y, w, h] }</c>, in the page's viewport CSS
/// pixels, with no other members. The host draws the menu; the page learns nothing back.
/// </summary>
internal readonly record struct DesktopInstanceMenuRequest(FrameRect Anchor)
{
    internal static DesktopInstanceMenuRequest? Parse(string? json)
    {
        if (string.IsNullOrEmpty(json) || json.Length > 1024)
            return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;
            string? type = null;
            FrameRect? anchor = null;
            var members = 0;
            foreach (var member in root.EnumerateObject())
            {
                members++;
                switch (member.Name)
                {
                    case "type" when member.Value.ValueKind == JsonValueKind.String:
                        type = member.Value.GetString();
                        break;
                    case "anchor":
                        anchor = DesktopFrameRegions.ParseRect(member.Value);
                        if (anchor is null)
                            return null;
                        break;
                    default:
                        return null;
                }
            }
            if (members != 2 || type != "instance-menu" || anchor is not { } rect)
                return null;
            return new DesktopInstanceMenuRequest(rect);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
