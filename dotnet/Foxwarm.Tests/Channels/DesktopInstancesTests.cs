namespace Foxwarm.Tests;

public sealed class DesktopInstancesTests
{
    [Theory]
    [InlineData("https://lab.example/foxwarm/", "https://lab.example/foxwarm/")]
    [InlineData("  https://lab.example/foxwarm  ", "https://lab.example/foxwarm/")]
    [InlineData("https://lab.example", "https://lab.example/")]
    [InlineData("https://lab.example:443/foxwarm/?token=x#tab", "https://lab.example/foxwarm/")]
    [InlineData("HTTP://Lab.Example:3001/Foxwarm", "http://lab.example:3001/Foxwarm/")]
    [InlineData("lab.example/foxwarm", "https://lab.example/foxwarm/")]
    [InlineData("lab.example:8443", "https://lab.example:8443/")]
    [InlineData("localhost:3001", "http://localhost:3001/")]
    [InlineData("192.168.1.20:3001/", "http://192.168.1.20:3001/")]
    [InlineData("[::1]:3001", "http://[::1]:3001/")]
    [InlineData("workstation:3001", "http://workstation:3001/")]
    [InlineData("https://lab.example/a b/", "https://lab.example/a%20b/")]
    public void Normalizes_typed_instance_urls(string input, string expected) =>
        Assert.Equal(expected, DesktopInstances.Normalize(input)?.AbsoluteUri);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("ftp://lab.example/")]
    [InlineData("file:///etc/passwd")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://user:secret@lab.example/")]
    [InlineData("https://")]
    public void Rejects_anything_but_http_instance_urls(string? input) =>
        Assert.Null(DesktopInstances.Normalize(input));

    [Theory]
    [InlineData("https://lab.example/foxwarm/", "lab.example/foxwarm")]
    [InlineData("https://lab.example/", "lab.example")]
    [InlineData("http://192.168.1.20:3001/", "192.168.1.20:3001")]
    [InlineData("https://lab.example/a%20b/", "lab.example/a b")]
    public void Labels_name_host_port_and_base_path(string url, string expected) =>
        Assert.Equal(expected, DesktopInstances.Label(new Uri(url)));

    [Fact]
    public void Settings_round_trip_through_the_file_and_default_to_local()
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-desktop-instances-" + Guid.NewGuid().ToString("N"));
        try
        {
            var empty = DesktopInstances.Load(root);
            Assert.Null(empty.Selected);
            Assert.Empty(empty.Remotes);
            Assert.False(File.Exists(Path.Combine(root, DesktopInstances.FileName)));

            var lab = empty.Add(new Uri("https://lab.example/foxwarm"));
            var other = empty.Add(new Uri("http://192.168.1.20:3001/"));
            Assert.Same(lab, empty.Add(new Uri("https://lab.example/foxwarm/")));
            empty.Select(lab);

            var loaded = DesktopInstances.Load(root);
            Assert.Equal(new[] { lab, other }, loaded.Remotes);
            Assert.Equal(lab, loaded.Selected);

            // Removing the selected remote selects the local instance.
            loaded.Remove(lab);
            var after = DesktopInstances.Load(root);
            Assert.Equal(new[] { other }, after.Remotes);
            Assert.Null(after.Selected);
            Assert.False(File.Exists(Path.Combine(root, DesktopInstances.FileName + ".tmp")));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"selected\":\"https://gone.example/\",\"remotes\":[]}")]
    [InlineData("{\"selected\":\"local\",\"remotes\":[{\"url\":\"ftp://x/\"},{\"url\":3},\"https://bare.example/\"]}")]
    public void Unusable_settings_select_local_and_skip_invalid_remotes(string json)
    {
        var instances = DesktopInstances.Parse(json);
        Assert.Null(instances.Selected);
        Assert.Empty(instances.Remotes);
    }

    [Fact]
    public void Written_settings_name_the_selection_and_each_remote()
    {
        var instances = DesktopInstances.Parse(
            "{\"selected\":\"https://lab.example/foxwarm\",\"remotes\":[{\"url\":\"https://lab.example/foxwarm/\"},{\"url\":\"https://lab.example/foxwarm\"}]}"
        );
        Assert.Equal("https://lab.example/foxwarm/", instances.Selected?.AbsoluteUri);
        Assert.Single(instances.Remotes);
        var reparsed = System.Text.Json.Nodes.JsonNode.Parse(instances.ToJson())!;
        Assert.Equal("https://lab.example/foxwarm/", (string?)reparsed["selected"]);
        Assert.Equal("https://lab.example/foxwarm/", (string?)reparsed["remotes"]![0]!["url"]);
        Assert.Equal("local", (string?)System.Text.Json.Nodes.JsonNode.Parse(DesktopInstances.Parse("{}").ToJson())!["selected"]);
    }

    [Fact]
    public void The_stop_confirmation_counts_running_Sessions()
    {
        Assert.Equal("No Sessions are running.", DesktopInstances.RunningSessionsText(0));
        Assert.StartsWith("1 Session is running. It ", DesktopInstances.RunningSessionsText(1));
        Assert.StartsWith("3 Sessions are running. They ", DesktopInstances.RunningSessionsText(3));
    }

    [Fact]
    public void Instance_menu_requests_carry_only_an_anchor()
    {
        var request = DesktopInstanceMenuRequest.Parse("{\"type\":\"instance-menu\",\"anchor\":[12,8,120.5,32]}");
        Assert.Equal(new FrameRect(12, 8, 120.5, 32), request?.Anchor);
        Assert.Equal(
            new FrameRect(0, 0, 0, 0),
            DesktopInstanceMenuRequest.Parse("{\"anchor\":[0,0,0,0],\"type\":\"instance-menu\"}")?.Anchor
        );
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("{\"type\":\"instance-menu\"}")]
    [InlineData("{\"type\":\"instance-menu\",\"anchor\":[1,2,3]}")]
    [InlineData("{\"type\":\"instance-menu\",\"anchor\":[1,2,-3,4]}")]
    [InlineData("{\"type\":\"instance-menu\",\"anchor\":[1,2,3,\"4\"]}")]
    [InlineData("{\"type\":\"instance-menu\",\"anchor\":[1,2,3,1e9]}")]
    [InlineData("{\"type\":\"instance-menu\",\"anchor\":[1,2,3,4],\"url\":\"https://x/\"}")]
    [InlineData("{\"type\":\"frame-regions\",\"anchor\":[1,2,3,4]}")]
    [InlineData("{\"type\":\"frame-regions\",\"regions\":[],\"colorScheme\":\"dark\"}")]
    public void Rejects_other_instance_menu_shapes(string? json) =>
        Assert.Null(DesktopInstanceMenuRequest.Parse(json));

    [Fact]
    public void Frame_region_messages_are_not_menu_requests_and_back() =>
        Assert.Null(DesktopFrameRegions.Parse("{\"type\":\"instance-menu\",\"anchor\":[1,2,3,4]}"));
}
