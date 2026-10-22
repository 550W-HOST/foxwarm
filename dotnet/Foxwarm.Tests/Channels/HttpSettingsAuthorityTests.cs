using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HttpSettingsAuthorityTests
{
    // These retired names must not override the ordinary YAML/default owner.
    private static readonly string[] RetiredVariables =
    [
        "FOXWARM_PUBLIC_BASE_URL",
        "FOXWARM_HTTP_PORT",
        "FOXWARM_BIND_ADDRESS",
        "FOXWARM_EXPERIMENT_PORT",
        "FOXWARM_EXPERIMENT_BIND_ADDRESS",
    ];

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Normal_capture_uses_YAML_or_defaults_despite_inherited_retired_settings(bool configured)
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            configured ? "url: https://yaml.example/mount\nbot: {httpPort: 39123}\n" : "{}\n"
        );
        var previous = RetiredVariables.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var name in RetiredVariables)
                Environment.SetEnvironmentVariable(name, "invalid-retired-input");
            var configuration = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path));
            var settings = await HttpServerSettings.CaptureAsync(configuration, temp.Path);
            Assert.Equal(configured ? 39123 : 3001, settings.Port);
            Assert.Equal("0.0.0.0", settings.BindAddress);
            Assert.Equal(configured ? "https://yaml.example/mount/" : "http://127.0.0.1:3001/", settings.Address.BaseUrl);
            Assert.Equal(configured ? "/mount" : "", settings.Address.Prefix.Value);
            Assert.Equal(configured, settings.Address.Secure);
            if (configured)
            {
                var saved = await configuration.SaveAppAsync("url: https://saved.example/next\nbot: {httpPort: 39124}\n");
                Assert.Contains("bot", saved["restartRequired"]!.ToJsonString());
                Assert.Equal(39123, settings.Port);
                var reopened = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path));
                var next = await HttpServerSettings.CaptureAsync(reopened, temp.Path);
                Assert.Equal(39124, next.Port);
                Assert.Equal("https://saved.example/next/", next.Address.BaseUrl);
                Assert.Equal(settings.Token, next.Token);
            }
        }
        finally
        {
            foreach (var (name, value) in previous)
                Environment.SetEnvironmentVariable(name, value);
        }
    }
}
