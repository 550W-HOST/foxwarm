namespace Foxwarm.Tools;

internal sealed record TargetFileStat(
    string Kind,
    long Size,
    double ModifiedAtMs,
    string? Name = null
);
