using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    private async Task<ExecRecord> LaunchWindowsAsync(
        ExecRecord allocated,
        string agentDirectory,
        CancellationToken ct
    )
    {
        var commandPath = Path.Combine(allocated.Directory, "user.ps1");
        var scriptPath = Path.Combine(allocated.Directory, "command.ps1");
        // Windows PowerShell 5.1 needs a BOM for non-ASCII script source. As in
        // Source, a separate user script preserves exit and LASTEXITCODE semantics.
        await File.WriteAllTextAsync(
            commandPath,
            allocated.Command + "\n",
            new UTF8Encoding(true),
            ct
        );
        await File.WriteAllTextAsync(scriptPath, WindowsWrapper, new UTF8Encoding(true), ct);
        var start = new ProcessStartInfo(WindowsPowerShell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = allocated.Cwd,
        };
        foreach (
            var argument in new[]
            {
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
            }
        )
            start.ArgumentList.Add(argument);
        // Keep the existing Main adapter's finite environment, with the Windows
        // process/runtime variables required by native executables and PowerShell.
        start.Environment.Clear();
        foreach (
            var key in new[]
            {
                "PATH",
                "HOME",
                "LANG",
                "LC_ALL",
                "TERM",
                "TMPDIR",
                "USER",
                "SystemRoot",
                "WINDIR",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "ComSpec",
                "PATHEXT",
                "PSModulePath",
            }
        )
            if (Environment.GetEnvironmentVariable(key) is { Length: > 0 } value)
                start.Environment[key] = value;
        start.Environment["fw_agentdir"] = agentDirectory;
        start.Environment["fw_tmp"] = Path.Combine(agentDirectory, "tmp");
        start.Environment["FOXWARM_EXEC_COMMAND_PATH"] = commandPath;
        start.Environment["FOXWARM_EXEC_LOG_PATH"] = Path.Combine(
            allocated.Directory,
            "output.log"
        );
        start.Environment["FOXWARM_EXEC_STATUS_PATH"] = Path.Combine(
            allocated.Directory,
            "status.json"
        );
        start.Environment["FOXWARM_EXEC_CWD_PATH"] = Path.Combine(allocated.Directory, "cwd.txt");
        ct.ThrowIfCancellationRequested();
        // No redirected Main-owned descriptors or kill-on-close job: this shell
        // owns its transcript and sidecars and survives ordinary Main shutdown.
        using var process =
            Process.Start(start) ?? throw new IOException("Failed to launch PowerShell.");
        var record = allocated with
        {
            Pid = process.Id,
            StartedAt = new DateTimeOffset(
                process.StartTime.ToUniversalTime()
            ).ToUnixTimeMilliseconds(),
            ProcessStartTicks = ReadProcessIdentity(process.Id).Ticks,
        };
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "meta.json"),
            JsonSerializer.Serialize(record) + "\n"
        );
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "tracking.json"),
            "{\"notify\":false}\n"
        );
        pending[Key(record.SessionId, record.Id)] = record;
        return record;
    }

    internal static string WindowsPowerShell =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );

    private const string WindowsWrapper = """
        $ErrorActionPreference = 'Continue'
        chcp 65001 | Out-Null
        Start-Transcript -LiteralPath $env:FOXWARM_EXEC_LOG_PATH -Append | Out-Null
        $global:LASTEXITCODE = $null
        $foxwarmExecSucceeded = $true
        try {
          & $env:FOXWARM_EXEC_COMMAND_PATH
          $foxwarmExecSucceeded = $?
        } catch {
          Write-Error $_
          $foxwarmExecSucceeded = $false
        }
        if ($null -ne $global:LASTEXITCODE) { $EXIT_CODE = [int]$global:LASTEXITCODE }
        elseif ($foxwarmExecSucceeded) { $EXIT_CODE = 0 }
        else { $EXIT_CODE = 1 }
        $finished = [DateTime]::UtcNow.ToString('o')
        $cwdTmp = "$env:FOXWARM_EXEC_CWD_PATH.tmp.$PID"
        (Get-Location).Path | Set-Content -LiteralPath $cwdTmp -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $cwdTmp -Destination $env:FOXWARM_EXEC_CWD_PATH -Force
        Stop-Transcript | Out-Null
        $statusTmp = "$env:FOXWARM_EXEC_STATUS_PATH.tmp.$PID"
        @{ exitCode = $EXIT_CODE; finishedAt = $finished } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusTmp -Encoding UTF8
        Move-Item -LiteralPath $statusTmp -Destination $env:FOXWARM_EXEC_STATUS_PATH -Force
        exit $EXIT_CODE
        """;
}
