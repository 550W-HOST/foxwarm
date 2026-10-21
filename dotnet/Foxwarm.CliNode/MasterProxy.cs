using System.Net;
using System.Text.RegularExpressions;

namespace Foxwarm.CliNode;

// Resolve only proxy-from-env inputs, not the platform's implicit system proxy.
internal static class MasterProxy
{
    internal static Uri? Resolve(Uri target, Func<string, string?>? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariable;
        string Env(string key) =>
            environment(key.ToLowerInvariant()) is { Length: > 0 } lower
                ? lower
                : environment(key.ToUpperInvariant()) ?? "";
        var scheme = target.Scheme is "wss" or "https" ? "https" : "http";
        var noProxy = (
            Env("npm_config_no_proxy") is { Length: > 0 } npm ? npm : Env("no_proxy")
        ).ToLowerInvariant();
        if (noProxy == "*")
            return null;
        foreach (var entry in Regex.Split(noProxy, @"[,\s]"))
        {
            if (entry.Length == 0)
                continue;
            var match = Regex.Match(entry, @"^(.+):(\d+)$");
            var host = match.Success ? match.Groups[1].Value : entry;
            if (
                match.Success
                && int.Parse(
                    match.Groups[2].Value,
                    System.Globalization.CultureInfo.InvariantCulture
                )
                    is > 0
                        and var port
                && port != target.Port
            )
                continue;
            var targetHost = target.Host.ToLowerInvariant();
            if (
                host[0] is not ('.' or '*')
                    ? targetHost == host
                    : targetHost.EndsWith(
                        host[0] == '*' ? host[1..] : host,
                        StringComparison.Ordinal
                    )
            )
                return null;
        }
        var proxy = new[]
        {
            Env("npm_config_" + scheme + "_proxy"),
            Env(scheme + "_proxy"),
            Env("npm_config_proxy"),
            Env("all_proxy"),
        }.FirstOrDefault(value => value.Length > 0);
        return proxy is null
            ? null
            : new Uri(
                proxy.Contains("://", StringComparison.Ordinal) ? proxy : scheme + "://" + proxy
            );
    }

    internal static WebProxy? Create(Uri target)
    {
        var uri = Resolve(target);
        if (uri is null)
            return null;
        var proxy = new WebProxy(new UriBuilder(uri) { UserName = "", Password = "" }.Uri);
        if (uri.UserInfo.Length > 0)
        {
            var parts = uri.UserInfo.Split(':', 2);
            proxy.Credentials = new NetworkCredential(
                Uri.UnescapeDataString(parts[0]),
                parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : ""
            );
        }
        return proxy;
    }

    internal static string Safe(Uri uri) =>
        new UriBuilder(uri) { Password = uri.UserInfo.Contains(':') ? "***" : "" }
            .Uri
            .AbsoluteUri;
}
