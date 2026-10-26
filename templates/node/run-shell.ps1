<#
.SYNOPSIS
  Exec-only Windows Shell Node. Requires Windows PowerShell 5.1 and inbox .NET.
.DESCRIPTION
  Use a per-node token from /node create, not the shared pairing token.
  Run from the desired default command directory. No Node.js installation is needed.
  Commands use fresh Windows PowerShell processes with bounded output, not full logs.
#>
#requires -Version 5.1
param(
    [string]$HostUrl = "__FOXWARM_DEFAULT_BASE_URL__",
    [string]$NodeId = "",
    [string]$AuthToken = $env:NODE_AUTH_TOKEN
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This Shell Node requires Windows PowerShell on Windows.' }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'This Shell Node requires FullLanguage PowerShell.' }
$uri = $null
if (-not [Uri]::TryCreate($HostUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'An HTTP(S) HostUrl without credentials, query or fragment is required.'
}
if ($NodeId -notmatch '^[a-zA-Z0-9_-]+$') { throw 'A NodeId from /node create is required.' }
if ($AuthToken -notmatch '^[a-fA-F0-9]{64}$') { throw 'A per-node token from /node create is required.' }
$startup = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Get-Location).Path)
# Do not pass the token to child processes through their inherited environment.
Remove-Item Env:NODE_AUTH_TOKEN -ErrorAction SilentlyContinue
$engine = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $engine)) { throw 'Windows PowerShell powershell.exe is required.' }

if (-not ('Foxwarm.ShellHttpClient' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Foxwarm
{
    // C# 5 / inbox .NET Framework surface: no package or resident service dependency.
    public sealed class ShellHttpClient
    {
        const string Protocol = "foxwarm-shell-1";
        readonly string host;
        readonly string node;
        readonly string auth;
        readonly string startup;
        readonly string engine;
        string connection;
        string predecessor;
        bool legacy;
        readonly HashSet<string> delivered = new HashSet<string>();
        readonly Queue<string> finished = new Queue<string>();
        readonly object jobsGate = new object();
        int jobs;

        public ShellHttpClient(string host, string node, string auth, string startup, string engine)
        {
            this.host = host.TrimEnd('/');
            this.node = node;
            this.auth = auth;
            this.startup = startup;
            this.engine = engine;
        }

        sealed class Reply
        {
            internal int Status;
            internal WebHeaderCollection Headers = new WebHeaderCollection();
            internal byte[] Body = new byte[0];
            internal bool Marked
            {
                get { return Headers["X-Foxwarm-Shell"] == Protocol; }
            }
        }

        Reply Http(
            string endpoint,
            byte[] body,
            Dictionary<string, string> headers,
            bool prepare = false
        )
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(host + "/node/shell/" + endpoint);
                request.Method =
                    prepare ? "HEAD"
                    : endpoint == "poll" ? "GET"
                    : "POST";
                request.AllowAutoRedirect = false;
                // The bootstrap may already have created this origin's ServicePoint.
                // Set its limit directly so report workers cannot serialize behind a two-connection default.
                var point = request.ServicePoint;
                point.ConnectionLimit = Math.Max(point.ConnectionLimit, 64);
                request.Timeout = 35000;
                request.ReadWriteTimeout = 35000;
                request.Headers["Authorization"] = "Bearer " + auth;
                request.Headers["X-Foxwarm-Node"] = node;
                if (connection != null)
                    request.Headers["X-Foxwarm-Connection"] = connection;
                if (headers != null)
                    foreach (var pair in headers)
                        request.Headers[pair.Key] = pair.Value;
                if (body != null)
                {
                    request.ContentType = "application/octet-stream";
                    request.ContentLength = body.Length;
                    using (var stream = request.GetRequestStream())
                        stream.Write(body, 0, body.Length);
                }
                HttpWebResponse response;
                try
                {
                    response = (HttpWebResponse)request.GetResponse();
                }
                catch (WebException error)
                {
                    response = error.Response as HttpWebResponse;
                    if (response == null)
                        return new Reply();
                }
                using (response)
                {
                    var reply = new Reply
                    {
                        Status = (int)response.StatusCode,
                        Headers = response.Headers,
                    };
                    using (var input = response.GetResponseStream())
                    using (var output = new MemoryStream())
                    {
                        var block = new byte[4096];
                        int size;
                        while ((size = input.Read(block, 0, block.Length)) > 0)
                        {
                            if (output.Length + size > 65536)
                                return new Reply();
                            output.Write(block, 0, size);
                        }
                        reply.Body = output.ToArray();
                    }
                    return reply;
                }
            }
            catch (WebException)
            {
                return new Reply();
            }
            catch (IOException)
            {
                return new Reply();
            }
        }

        static bool Terminal(int status)
        {
            return status == 400
                || status == 401
                || status == 403
                || status == 409
                || status == 410
                || status == 413
                || status == 415;
        }

        bool Report(
            string task,
            string kind,
            byte[] sample,
            long total,
            int exit,
            long elapsed,
            DateTime started,
            string dispatchedConnection
        )
        {
            var headers = new Dictionary<string, string>
            {
                { "X-Foxwarm-Connection", dispatchedConnection },
                { "X-Foxwarm-Task", task },
                { "X-Foxwarm-Result", kind },
                { "X-Foxwarm-Bytes", total.ToString(CultureInfo.InvariantCulture) },
                { "X-Foxwarm-Exit", exit.ToString(CultureInfo.InvariantCulture) },
                { "X-Foxwarm-Elapsed-Seconds", elapsed.ToString(CultureInfo.InvariantCulture) },
            };
            while ((DateTime.UtcNow - started).TotalSeconds <= 86400)
            {
                var reply = Http("report", sample, headers);
                if (reply.Status == 204 && reply.Marked)
                    return true;
                if (Terminal(reply.Status))
                    return false;
                Thread.Sleep(2000);
            }
            return false;
        }

        sealed class Sample
        {
            readonly byte[] head = new byte[4096],
                tail = new byte[4096];
            internal long Total;

            internal void Append(byte[] block, int size)
            {
                lock (this)
                {
                    for (int i = 0; i < size; i++)
                    {
                        if (Total < 4096)
                            head[(int)Total] = block[i];
                        tail[(int)(Total % 4096)] = block[i];
                        Total++;
                    }
                }
            }

            internal void Drain(Stream input)
            {
                using (input)
                {
                    var block = new byte[4096];
                    int size;
                    while ((size = input.Read(block, 0, block.Length)) > 0)
                        Append(block, size);
                }
            }

            internal byte[] Bytes()
            {
                var output = new byte[(int)Math.Min(Total, 8192)];
                int first = (int)Math.Min(Total, 4096);
                Buffer.BlockCopy(head, 0, output, 0, first);
                int rest = output.Length - first;
                for (int i = 0; i < rest; i++)
                    output[first + i] = tail[(int)((Total - rest + i) % 4096)];
                return output;
            }
        }

        void RunJob(
            string task,
            byte[] script,
            int timeout,
            DateTime dispatched,
            string dispatchedConnection
        )
        {
            string directory = null;
            var sample = new Sample();
            int exit = 125;
            long elapsed = 0;
            try
            {
                // Create a private job directory before writing the bounded script.
                directory = Path.Combine(
                    Path.GetTempPath(),
                    "foxwarm-shell-" + Guid.NewGuid().ToString("N")
                );
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(
                    new FileSystemAccessRule(
                        WindowsIdentity.GetCurrent().User,
                        FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None,
                        AccessControlType.Allow
                    )
                );
                Directory.CreateDirectory(directory, security);
                var path = Path.Combine(directory, "command.ps1");
                var text =
                    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n"
                    + "$OutputEncoding = [Console]::OutputEncoding\n"
                    + Encoding.UTF8.GetString(script)
                    + "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\n";
                File.WriteAllText(path, text, new UTF8Encoding(true));
                // Match the bootstrap's in-memory execution under the default Windows policy.
                // Only this fixed, short file-reader expression travels in argv; the command stays bounded on disk.
                var invoke =
                    "& ([ScriptBlock]::Create([IO.File]::ReadAllText('"
                    + path.Replace("'", "''")
                    + "', [Text.Encoding]::UTF8)))";
                var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(invoke));
                var info = new ProcessStartInfo(
                    engine,
                    "-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand "
                        + encoded
                )
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = startup,
                };
                using (var process = new Process { StartInfo = info })
                {
                    var watch = Stopwatch.StartNew();
                    process.Start();
                    // Independent readers keep both pipes drained, including no-newline/binary output.
                    var stdout = new Thread(() => sample.Drain(process.StandardOutput.BaseStream));
                    var stderr = new Thread(() => sample.Drain(process.StandardError.BaseStream));
                    stdout.Start();
                    stderr.Start();
                    using (var completed = new ManualResetEvent(false))
                    {
                        var runner = new Thread(() =>
                        {
                            process.WaitForExit();
                            elapsed = (long)watch.Elapsed.TotalSeconds;
                            exit = process.ExitCode;
                            stdout.Join();
                            stderr.Join();
                            completed.Set();
                        });
                        runner.Start();
                        if (!completed.WaitOne(timeout * 1000))
                        {
                            if (
                                !Report(
                                    task,
                                    "background",
                                    new byte[0],
                                    0,
                                    0,
                                    (long)watch.Elapsed.TotalSeconds,
                                    dispatched,
                                    dispatchedConnection
                                )
                            )
                                Console.Error.WriteLine(
                                    "Background result unavailable; command will not be executed again."
                                );
                        }
                        completed.WaitOne();
                        runner.Join();
                    }
                }
            }
            catch (Exception)
            {
                // Do not leak a command, token or private path through bootstrap diagnostics.
                var error = Encoding.UTF8.GetBytes(
                    "Shell Node could not start or collect the command.\n"
                );
                sample.Append(error, error.Length);
            }
            if (
                !Report(
                    task,
                    "finished",
                    sample.Bytes(),
                    sample.Total,
                    exit,
                    elapsed,
                    dispatched,
                    dispatchedConnection
                )
            )
                Console.Error.WriteLine(
                    "Completion unavailable; command will not be executed again."
                );
            if (directory != null)
            {
                try
                {
                    Directory.Delete(directory, true);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        static bool ConnectionId(string value)
        {
            return value != null && Regex.IsMatch(value, "^[a-f0-9]{32}$");
        }

        static void Stopped(int status, string reason = null)
        {
            Console.Error.WriteLine(
                status == 401 || status == 403
                    ? "Shell Node stopped: credentials rejected or revoked."
                : status == 409
                    ? (
                        reason == "connection-replaced"
                            ? "Shell Node stopped: connection replaced by another client."
                            : "Shell Node stopped: connection conflict; safe automatic reconnect is unavailable."
                    )
                : status == 410 ? "Shell Node stopped: connection retired by server."
                : "Shell Node stopped: registration request rejected."
            );
        }

        void Prepare()
        {
            bool retrying = false;
            while (true)
            {
                var reply = Http("register", null, null, true);
                var proposed = reply.Headers["X-Foxwarm-Connection"];
                var previous = reply.Headers["X-Foxwarm-Predecessor"];
                if (
                    reply.Status == 204
                    && reply.Marked
                    && ConnectionId(proposed)
                    && (previous == "none" || ConnectionId(previous))
                )
                {
                    connection = proposed;
                    predecessor = previous;
                    return;
                }
                if (reply.Status == 404 || reply.Status == 405 || reply.Status == 501)
                {
                    legacy = true;
                    return;
                }
                if (Terminal(reply.Status))
                {
                    Stopped(reply.Status, reply.Headers["X-Foxwarm-Shell-Reason"]);
                    throw new InvalidOperationException(
                        "Shell Node registration failed; no command was executed."
                    );
                }
                if (!retrying)
                    Console.Error.WriteLine(
                        "Shell Node registration unavailable; retrying in 2 seconds."
                    );
                retrying = true;
                Thread.Sleep(2000);
            }
        }

        bool Register()
        {
            bool retrying = false;
            while (true)
            {
                var headers = new Dictionary<string, string>
                {
                    { "X-Foxwarm-Shell-Dialect", "powershell" },
                };
                if (!legacy)
                    headers["X-Foxwarm-Predecessor"] = predecessor;
                var reply = Http("register", Encoding.UTF8.GetBytes(startup), headers);
                var registered = reply.Headers["X-Foxwarm-Connection"];
                if (
                    reply.Status == 204
                    && reply.Marked
                    && ConnectionId(registered)
                    && (legacy || registered == connection)
                )
                {
                    connection = registered;
                    predecessor = connection;
                    return true;
                }
                if (Terminal(reply.Status))
                {
                    Stopped(reply.Status, reply.Headers["X-Foxwarm-Shell-Reason"]);
                    return false;
                }
                if (legacy)
                {
                    Console.Error.WriteLine(
                        "Shell Node registration unconfirmed; this server does not support safe registration retry."
                    );
                    return false;
                }
                if (!retrying)
                    Console.Error.WriteLine(
                        "Shell Node registration unavailable; retrying in 2 seconds."
                    );
                retrying = true;
                Thread.Sleep(2000);
            }
        }

        public void Run()
        {
            // Windows PowerShell 5.1 may otherwise offer only older TLS protocol defaults.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            Prepare();
            if (!Register())
                throw new InvalidOperationException(
                    "Shell Node registration failed; no command was executed."
                );
            Console.WriteLine(
                "Shell Node " + node + " ready (Windows PowerShell, bounded output)."
            );
            bool retrying = false;
            try
            {
                while (true)
                {
                    var reply = Http("poll", null, null);
                    if (reply.Status == 204 && reply.Marked)
                    {
                        if (retrying)
                            Console.Error.WriteLine("Shell Node polling resumed.");
                        retrying = false;
                        continue;
                    }
                    var reason = reply.Headers["X-Foxwarm-Shell-Reason"];
                    if (reply.Status == 409 && reply.Marked && !legacy)
                    {
                        if (reason == "connection-unavailable")
                        {
                            Console.Error.WriteLine(
                                "Shell Node connection expired or Main restarted; reconnecting."
                            );
                            if (!Register())
                                break;
                            Console.Error.WriteLine(
                                "Shell Node reconnected; delivered commands are not replayed."
                            );
                            retrying = false;
                            continue;
                        }
                        if (reason == "poll-pending")
                        {
                            if (!retrying)
                                Console.Error.WriteLine(
                                    "Shell Node previous poll is still pending; retrying in 2 seconds."
                                );
                            retrying = true;
                            Thread.Sleep(2000);
                            continue;
                        }
                    }
                    if (
                        reply.Status == 401
                        || reply.Status == 403
                        || reply.Status == 409
                        || reply.Status == 410
                    )
                    {
                        Stopped(reply.Status, reply.Headers["X-Foxwarm-Shell-Reason"]);
                        break;
                    }
                    int timeout;
                    var task = reply.Headers["X-Foxwarm-Task"];
                    var exec = reply.Headers["X-Foxwarm-Exec"];
                    if (
                        reply.Status != 200
                        || !reply.Marked
                        || reply.Headers["Content-Type"]
                            != "application/x-foxwarm-shell; charset=utf-8"
                        || task == null
                        || !Regex.IsMatch(task, "^[a-f0-9]{32}$")
                        || exec == null
                        || !Regex.IsMatch(exec, "^[a-z0-9_-]+$")
                        || !Int32.TryParse(
                            reply.Headers["X-Foxwarm-Timeout"],
                            NumberStyles.None,
                            CultureInfo.InvariantCulture,
                            out timeout
                        )
                        || timeout < 1
                        || timeout > 60
                    )
                    {
                        if (!retrying)
                            Console.Error.WriteLine(
                                "Shell Node poll unavailable or invalid; retrying in 2 seconds."
                            );
                        retrying = true;
                        Thread.Sleep(2000);
                        continue;
                    }
                    if (retrying)
                        Console.Error.WriteLine("Shell Node polling resumed.");
                    retrying = false;
                    // Match Main's bounded recent receipts; Main never redelivers a handed-out task.
                    lock (jobsGate)
                    {
                        if (!delivered.Add(task))
                            continue;
                    }
                    var script = reply.Body;
                    var dispatched = DateTime.UtcNow;
                    var dispatchedConnection = connection;
                    lock (jobsGate)
                        jobs++;
                    var worker = new Thread(() =>
                    {
                        try
                        {
                            RunJob(task, script, timeout, dispatched, dispatchedConnection);
                        }
                        finally
                        {
                            lock (jobsGate)
                            {
                                finished.Enqueue(task);
                                while (finished.Count > 32)
                                    delivered.Remove(finished.Dequeue());
                                jobs--;
                                Monitor.PulseAll(jobsGate);
                            }
                        }
                    });
                    worker.Start();
                }
            }
            finally
            {
                // Replacement/revocation stops polling, not already delivered commands or reporters.
                lock (jobsGate)
                    while (jobs > 0)
                        Monitor.Wait(jobsGate);
            }
        }
    }
}
'@
}
try {
    $client = New-Object Foxwarm.ShellHttpClient($HostUrl, $NodeId, $AuthToken, $startup, $engine)
    $AuthToken = $null
    $client.Run()
} finally {
    $AuthToken = $null
}
