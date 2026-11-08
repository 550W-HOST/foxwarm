using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Secrets;

// Main-owned composition of the instance key, the encrypted store, the known-value
// redactor and exposure records. One instance exists per installation data root.
internal sealed partial class InstanceSecrets : IDisposable
{
    private static readonly TimeSpan SourceRefresh = TimeSpan.FromSeconds(5);

    private readonly object keyGate = new();
    private readonly object buildGate = new();
    private readonly TimeProvider clock;
    private readonly List<(string Id, Func<IEnumerable<KnownSecret>> Values)> sources = new();
    private InstanceKeys? keys;
    private SecretRedactor redactor = SecretRedactor.Empty;
    private long builtGeneration = -1;
    private long builtAt;
    private int invalidated = 1;
    private int rebuildScheduled;
    private string? lastBuildFailure;

    internal string KeyPath { get; }
    internal SecretStore Store { get; }
    internal SecretExposures Exposures { get; }
    internal Exception? KeyError { get; private set; }

    internal InstanceSecrets(string dataRoot, TimeProvider? clock = null)
    {
        this.clock = clock ?? TimeProvider.System;
        var root = Path.GetFullPath(dataRoot);
        KeyPath = InstanceKeys.DefaultPath(root);
        Store = new SecretStore(Path.Combine(root, "state", "secrets.json"), OpenKeys, this.clock);
        Exposures = new SecretExposures(
            Path.Combine(root, "state", "secret-exposures.json"),
            this.clock
        );
        Store.Changed += Invalidate;
    }

    // Main start creates the key once. Failure leaves the store locked instead of
    // aborting startup; Setup reports the state and references fail closed.
    internal void Open()
    {
        try
        {
            _ = OpenKeys();
        }
        catch (Exception error)
        {
            MainLog.Diagnostic(
                "Secret store is locked: " + MainLog.SafeFailure(error),
                failure: true
            );
        }
    }

    internal bool Locked
    {
        get
        {
            try
            {
                _ = OpenKeys();
                return false;
            }
            catch (Exception)
            {
                return true;
            }
        }
    }

    private InstanceKeys OpenKeys()
    {
        lock (keyGate)
        {
            if (keys is not null)
                return keys;
            try
            {
                // Never mint a replacement key for an existing store: restore the original.
                if (!File.Exists(KeyPath) && File.Exists(Store.FilePath))
                    throw new SecretStoreLockedException(
                        "The secret store is locked: the instance key file is missing."
                    );
                keys = InstanceKeys.OpenOrCreate(KeyPath);
                KeyError = null;
                return keys;
            }
            catch (Exception error)
            {
                KeyError = error;
                throw;
            }
        }
    }

    // Literal values from configuration that should also be masked. Each source is
    // re-read at most every few seconds, or immediately after Invalidate.
    internal void AddSource(string id, Func<IEnumerable<KnownSecret>> values)
    {
        lock (buildGate)
        {
            sources.RemoveAll(source => source.Id == id);
            sources.Add((id, values));
        }
        Invalidate();
    }

    internal void Invalidate()
    {
        Interlocked.Exchange(ref invalidated, 1);
        // Log lines and canonical appends use the last built matcher and never rebuild it;
        // rebuild in the background so they see changes without waiting for other traffic.
        if (Interlocked.Exchange(ref rebuildScheduled, 1) == 0)
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Interlocked.Exchange(ref rebuildScheduled, 0);
                _ = Redactor;
            });
    }

    // The last built matcher without refreshing sources. Log writers use this: a rebuild
    // takes configuration locks and must never run under a console writer lock.
    internal SecretRedactor LastBuilt => Volatile.Read(ref redactor);

    // A rebuild can log a source failure; that log line must not re-enter the rebuild.
    [ThreadStatic]
    private static bool building;

    internal SecretRedactor Redactor
    {
        get
        {
            if (building || Current(clock.GetTimestamp()))
                return Volatile.Read(ref redactor);
            // Wait for a concurrent rebuild rather than masking with an older matcher.
            Monitor.Enter(buildGate);
            building = true;
            try
            {
                var now = clock.GetTimestamp();
                if (Current(now))
                    return redactor;
                Interlocked.Exchange(ref invalidated, 0);
                var generation = Store.Generation;
                var known = new List<KnownSecret>();
                try
                {
                    foreach (var (name, value) in Store.RedactionValues())
                        known.Add(new KnownSecret(name, value));
                }
                catch (Exception error)
                    when (error is SecretStoreLockedException or InvalidDataException or IOException
                    )
                {
                    Report("store", error);
                }
                foreach (var (id, values) in sources)
                {
                    try
                    {
                        known.AddRange(values());
                    }
                    catch (Exception error)
                    {
                        Report(id, error);
                    }
                }
                Volatile.Write(ref redactor, new SecretRedactor(known));
                Interlocked.Exchange(ref builtGeneration, generation);
                Interlocked.Exchange(ref builtAt, now);
                return redactor;
            }
            finally
            {
                building = false;
                Monitor.Exit(buildGate);
            }
        }
    }

    private bool Current(long now) =>
        Volatile.Read(ref invalidated) == 0
        && Store.Generation == Interlocked.Read(ref builtGeneration)
        && clock.GetElapsedTime(Interlocked.Read(ref builtAt), now) < SourceRefresh;

    private void Report(string source, Exception error)
    {
        var line =
            "Secret redaction source " + source + " is unavailable: " + MainLog.SafeFailure(error);
        if (line == lastBuildFailure)
            return;
        lastBuildFailure = line;
        MainLog.Diagnostic(line, failure: true);
    }

    // Resolution for Main-owned sinks. A locked store fails closed.
    internal string? Lookup(string name) => Store.Resolve(name);

    internal T Resolve<T>(T document, SecretSinks sinks, string label, ICollection<string> missing)
        where T : JsonNode => SecretReferences.Resolve(document, sinks, label, Lookup, missing);

    internal string Redact(string text, string source, string? sessionId = null)
    {
        var hits = new List<string>();
        var result = Redactor.Redact(text, hits);
        if (hits.Count > 0)
            Exposures.Record(hits, source, sessionId);
        return result;
    }

    internal JsonNode? Redact(JsonNode? node, string source, string? sessionId = null)
    {
        var hits = new List<string>();
        var result = Redactor.Redact(node, hits);
        if (hits.Count > 0)
            Exposures.Record(hits, source, sessionId);
        return result;
    }

    // Canonical history/request message masking; reasoning is reported, never rewritten.
    internal JsonObject RedactMessage(
        JsonObject message,
        string source,
        string? sessionId = null
    ) => RedactMessage(Redactor, message, source, sessionId);

    internal JsonObject RedactMessage(
        SecretRedactor current,
        JsonObject message,
        string source,
        string? sessionId
    )
    {
        var findings = new SecretMessageRedaction.Findings();
        var result = SecretMessageRedaction.Message(current, message, findings);
        Record(findings, source, sessionId);
        return result;
    }

    internal void Record(SecretMessageRedaction.Findings findings, string source, string? sessionId)
    {
        if (findings.Masked.Count > 0)
            Exposures.Record(findings.Masked, source, sessionId);
        if (findings.Reasoning.Count > 0)
            Exposures.Record(findings.Reasoning, source + "-reasoning", sessionId);
    }

    public void Dispose() => Exposures.Dispose();

    // Literal credentials in sink fields, labelled with their configuration location.
    internal static IEnumerable<KnownSecret> Literals(
        SecretSinks sinks,
        JsonNode? document,
        Func<string, string> label
    )
    {
        foreach (var field in sinks.Fields(document))
        {
            if (SecretReferences.Contains(field.Value))
                continue;
            switch (field.Kind)
            {
                case SecretSinkKind.Credential:
                    yield return new KnownSecret(label(field.Path), field.Value);
                    break;
                case SecretSinkKind.Url:
                    foreach (var part in UrlSecretParts(field.Value))
                        yield return new KnownSecret(label(field.Path), part);
                    break;
                case SecretSinkKind.Environment
                    when CredentialName().IsMatch(field.Path[(field.Path.LastIndexOf('.') + 1)..]):
                    yield return new KnownSecret(label(field.Path), field.Value);
                    break;
            }
        }
    }

    // Environment names whose underscore- or dash-separated words name a credential.
    [GeneratedRegex(
        "(^|[_-])(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|AUTHORIZATION|CREDENTIALS?|COOKIE|SESSION|PRIVATE|PAT|DSN)([_-]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex CredentialName();

    // User info, query values and fragment: the URL parts that commonly carry credentials.
    internal static IEnumerable<string> UrlSecretParts(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return [url];
        var parts = new List<string>();
        if (uri.UserInfo.Length > 0)
        {
            parts.Add(Uri.UnescapeDataString(uri.UserInfo));
            var separator = uri.UserInfo.IndexOf(':');
            if (separator >= 0)
                parts.Add(Uri.UnescapeDataString(uri.UserInfo[(separator + 1)..]));
        }
        foreach (
            var item in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
        )
        {
            var equals = item.IndexOf('=');
            parts.Add(Uri.UnescapeDataString(equals >= 0 ? item[(equals + 1)..] : item));
        }
        if (uri.Fragment.Length > 1)
            parts.Add(Uri.UnescapeDataString(uri.Fragment[1..]));
        return parts.Where(part => part.Length > 0).Distinct(StringComparer.Ordinal);
    }
}
