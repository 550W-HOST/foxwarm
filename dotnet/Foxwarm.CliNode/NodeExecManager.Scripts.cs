namespace Foxwarm.CliNode;

internal sealed partial class NodeExecManager
{
    private static string UnixScript =>
        """
            #!/usr/bin/env bash
            set +e
            foxwarm_exec_choose_paths() {
              base_path="${FOXWARM_EXEC_LOG_DIR}/${FOXWARM_EXEC_TIME_TOKEN}_pid$$"
              index=0
              while :; do
                if [ "$index" -eq 0 ]; then log_path="${base_path}.log"; else log_path="${base_path}_${index}.log"; fi
                status_path="${log_path}.exit.json"
                cwd_path="${log_path}.cwd.txt"
                if [ ! -e "$log_path" ] && [ ! -e "$status_path" ] && [ ! -e "$cwd_path" ]; then break; fi
                index=$((index + 1))
              done
              export FOXWARM_EXEC_LOG_PATH="$log_path"
              export FOXWARM_EXEC_STATUS_PATH="$status_path"
              export FOXWARM_EXEC_CWD_PATH="$cwd_path"
              paths_tmp="${FOXWARM_EXEC_PATHS_PATH}.tmp.$$"
            """
        + "\n  "
        + ExecNative.SelfCommand
        + " --exec-paths \"$paths_tmp\" \"$log_path\" \"$status_path\" \"$cwd_path\"\n"
        + """
              mv "$paths_tmp" "$FOXWARM_EXEC_PATHS_PATH"
              exec >> "$FOXWARM_EXEC_LOG_PATH" 2>&1
            }
            foxwarm_exec_choose_paths
            foxwarm_exec_finalize() {
              exit_code=$?
              cwd_tmp="${FOXWARM_EXEC_CWD_PATH}.tmp.$$"
              status_tmp="${FOXWARM_EXEC_STATUS_PATH}.tmp.$$"
              pwd > "$cwd_tmp"
              mv "$cwd_tmp" "$FOXWARM_EXEC_CWD_PATH"
            """
        + "\n  "
        + ExecNative.SelfCommand
        + " --exec-status \"$status_tmp\" \"$exit_code\"\n"
        + """
              mv "$status_tmp" "$FOXWARM_EXEC_STATUS_PATH"
            }
            trap foxwarm_exec_finalize EXIT
            set +e
            """;

    private const string WindowsScript = """
        $ErrorActionPreference = "Continue"
        chcp 65001 | Out-Null
        $basePath = Join-Path $env:FOXWARM_EXEC_LOG_DIR ("{0}_pid{1}" -f $env:FOXWARM_EXEC_TIME_TOKEN, $PID)
        $index = 0
        while ($true) {
          if ($index -eq 0) { $logPath = "$basePath.log" } else { $logPath = "${basePath}_$index.log" }
          $statusPath = "$logPath.exit.json"
          $cwdPath = "$logPath.cwd.txt"
          if (!(Test-Path -LiteralPath $logPath) -and !(Test-Path -LiteralPath $statusPath) -and !(Test-Path -LiteralPath $cwdPath)) { break }
          $index += 1
        }
        $pathsTmp = "$env:FOXWARM_EXEC_PATHS_PATH.tmp.$PID"
        @{ logPath = $logPath; statusPath = $statusPath; cwdPath = $cwdPath } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pathsTmp
        Move-Item -LiteralPath $pathsTmp -Destination $env:FOXWARM_EXEC_PATHS_PATH -Force
        Start-Transcript -LiteralPath $logPath -Append | Out-Null
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
        $cwdTmp = "$cwdPath.tmp.$PID"
        $statusTmp = "$statusPath.tmp.$PID"
        (Get-Location).Path | Set-Content -LiteralPath $cwdTmp -NoNewline
        Move-Item -LiteralPath $cwdTmp -Destination $cwdPath -Force
        @{ exitCode = $EXIT_CODE; finishedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusTmp
        Move-Item -LiteralPath $statusTmp -Destination $statusPath -Force
        Stop-Transcript | Out-Null
        exit $EXIT_CODE
        """;
}
