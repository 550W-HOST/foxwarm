using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HttpSettingsAuthorityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Capture_uses_YAML_or_defaults_and_recaptures_saved_settings(bool configured)
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            configured ? "url: https://yaml.example/mount\nbot: {httpPort: 39123}\n" : "{}\n"
        );
        var configuration = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path));
        var settings = await HttpServerSettings.CaptureAsync(configuration, temp.Path);
        Assert.Equal(configured ? 39123 : 3001, settings.Port);
        Assert.Equal("0.0.0.0", settings.BindAddress);
        Assert.Equal(
            configured ? "https://yaml.example/mount/" : "http://127.0.0.1:3001/",
            settings.Address.BaseUrl
        );
        Assert.Equal(configured ? "/mount" : "", settings.Address.Prefix.Value);
        Assert.Equal(configured, settings.Address.Secure);
        if (configured)
        {
            var saved = await configuration.SaveAppAsync(
                "url: https://saved.example/next\nbot: {httpPort: 39124}\n"
            );
            Assert.Contains("bot", saved["restartRequired"]!.ToJsonString());
            Assert.Equal(39123, settings.Port);
            var reopened = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path));
            var next = await HttpServerSettings.CaptureAsync(reopened, temp.Path);
            Assert.Equal(39124, next.Port);
            Assert.Equal("https://saved.example/next/", next.Address.BaseUrl);
            Assert.Equal(settings.Token, next.Token);
        }
    }
}
