namespace Foxwarm.Hosted;

/// <summary>Exit codes of a hosted replica process.</summary>
internal static class HostedExit
{
    internal const int Stopped = 0;

    /// <summary>Any other failure, for example an unreachable database; the orchestrator retries.</summary>
    internal const int Failed = 1;

    /// <summary>The replica lost or gave up ownership while running (EX_TEMPFAIL); restart it.</summary>
    internal const int Fenced = 75;

    /// <summary>Bootstrap, schema, tenant or store refusal (EX_CONFIG); restarting won't help.</summary>
    internal const int Configuration = 78;
}

/// <summary>A refusal to start the tenant runtime that no retry can fix.</summary>
internal sealed class HostedStartupException(string message) : Exception(message);

/// <summary>The tenant runtime an owner replica runs: today's Main host over hosted stores.</summary>
internal interface IHostedRuntime : IAsyncDisposable
{
    /// <summary>Starts serving.</summary>
    Task StartAsync();

    /// <summary>Completes when the runtime stopped on its own (for example a stop request).</summary>
    Task Stopped { get; }

    /// <summary>Abort streams authenticated with the superseded administrator credential.</summary>
    void CredentialRotated() { }
}
