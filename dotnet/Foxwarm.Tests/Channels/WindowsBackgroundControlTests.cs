using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Extensions.Hosting;

namespace Foxwarm.Tests;

public sealed class WindowsBackgroundControlTests
{
    private static WindowsBackgroundControl CreateControl(
        string pipeName,
        string dataRoot,
        IHostApplicationLifetime lifetime
    )
    {
        var previous = Environment.GetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE", pipeName);
            // The production Windows-only Start gate is not exercised; the protocol owner is.
            return (WindowsBackgroundControl)
                Activator.CreateInstance(
                    typeof(WindowsBackgroundControl),
                    BindingFlags.Instance | BindingFlags.NonPublic,
                    null,
                    [dataRoot, lifetime],
                    null
                )!;
        }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(
                error.InnerException
            ).Throw();
            throw;
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE", previous);
        }
    }

    private static async Task<JsonObject> StatusAsync(string pipeName)
    {
        await using var client = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous
        );
        await client.ConnectAsync(5000);
        await client.WriteAsync(Encoding.UTF8.GetBytes("status\n"));
        await client.FlushAsync();
        using var reader = new StreamReader(client, Encoding.UTF8);
        return JsonNode.Parse(await reader.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5)))!
            .AsObject();
    }

    [Fact]
    public async Task Status_reports_ready_only_after_the_host_has_started()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject { ["vector"] = false }.ToJsonString()
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            new ModelConfiguration(data),
            settings,
            null
        );
        var name = "foxwarm-ready-test-" + Guid.NewGuid().ToString("N");
        await using var control = CreateControl(name, data, host.Lifetime);

        var before = await StatusAsync(name);
        Assert.True(before["ok"]!.GetValue<bool>());
        Assert.False(before["ready"]!.GetValue<bool>());

        await host.StartAsync();

        Assert.True((await StatusAsync(name))["ready"]!.GetValue<bool>());
        await host.DisposeAsync();
    }

    [Fact]
    public async Task A_control_pipe_name_that_another_process_already_owns_is_refused_with_a_message()
    {
        // The server-side first-instance claim is a Windows named-pipe semantic.
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            new ModelConfiguration(data),
            settings,
            null
        );
        var name = "foxwarm-squat-test-" + Guid.NewGuid().ToString("N");
        using var squatter = new NamedPipeServerStream(
            name,
            PipeDirection.InOut,
            4,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous
        );

        var error = Assert.Throws<ControlPipeUnavailableException>(
            () => CreateControl(name, data, host.Lifetime)
        );

        Assert.Contains(name, error.Message);
        Assert.StartsWith("ControlPipeUnavailableException: ", MainLog.SafeFailure(error));
        Assert.Contains("already in use", MainLog.SafeFailure(error));
    }
}
