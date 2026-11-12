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
        Assert.Equal(settings.BindAddress, HttpServerSettings.ListenAddress(null));
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

    // Without a public url, Main's own address (Node bootstrap, OAuth, Code) is where a local
    // client reaches the listener: loopback for a wildcard, otherwise the listen address.
    [Theory]
    [InlineData("0.0.0.0", "0.0.0.0", "http://127.0.0.1:39125/")]
    [InlineData("127.0.0.1", "127.0.0.1", "http://127.0.0.1:39125/")]
    [InlineData("127.0.0.2", "127.0.0.2", "http://127.0.0.2:39125/")]
    [InlineData("'::1'", "::1", "http://[::1]:39125/")]
    [InlineData("'0:0:0:0:0:0:0:1'", "::1", "http://[::1]:39125/")]
    [InlineData("'::'", "::", "http://127.0.0.1:39125/")]
    [InlineData("192.0.2.10", "192.0.2.10", "http://192.0.2.10:39125/")]
    public async Task Listen_address_comes_from_YAML_and_sets_the_local_address(
        string yaml,
        string listen,
        string local
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            $"bot:\n  httpPort: 39125\n  httpHost: {yaml}\n"
        );
        var settings = await HttpServerSettings.CaptureAsync(
            new ModelConfiguration(HostPaths.ForDataRoot(temp.Path)),
            temp.Path
        );
        Assert.Equal(listen, settings.BindAddress);
        Assert.Equal(local, settings.Address.BaseUrl);
        // A configured public url still takes precedence.
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            $"url: https://public.example\nbot:\n  httpPort: 39125\n  httpHost: {yaml}\n"
        );
        var configured = await HttpServerSettings.CaptureAsync(
            new ModelConfiguration(HostPaths.ForDataRoot(temp.Path)),
            temp.Path
        );
        Assert.Equal(listen, configured.BindAddress);
        Assert.Equal("https://public.example/", configured.Address.BaseUrl);
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("example.com")]
    [InlineData("127.1")]
    [InlineData("1")]
    [InlineData("010.0.0.1")]
    [InlineData(" 127.0.0.1")]
    [InlineData("fe80::1%1")]
    [InlineData("[::1]")]
    [InlineData("")]
    public void Listen_address_accepts_only_IP_literals(string value)
    {
        var error = Assert.Throws<InvalidDataException>(() =>
            HttpServerSettings.ListenAddress(System.Text.Json.Nodes.JsonValue.Create(value))
        );
        Assert.Contains("Host names are not accepted", error.Message);
        Assert.Throws<InvalidDataException>(() =>
            HttpServerSettings.ListenAddress(System.Text.Json.Nodes.JsonValue.Create(8080))
        );
    }
}
