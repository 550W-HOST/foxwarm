namespace Foxwarm.Tests;

public sealed class DesktopFrameRegionsTests
{
    [Fact]
    public void Parses_the_exact_frame_regions_message()
    {
        var message = DesktopFrameRegions.Parse(
            """{"type":"frame-regions","regions":[[0,0,262,55],[1102.5,7,171,42]],"colorScheme":"dark"}"""
        );
        Assert.NotNull(message);
        Assert.True(message.Dark);
        Assert.Equal(
            [new FrameRect(0, 0, 262, 55), new FrameRect(1102.5, 7, 171, 42)],
            message.Regions
        );
        var empty = DesktopFrameRegions.Parse("""{"regions":[],"colorScheme":"light","type":"frame-regions"}""");
        Assert.NotNull(empty);
        Assert.False(empty.Dark);
        Assert.Empty(empty.Regions);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("\"frame-regions\"")]
    [InlineData("""{"type":"frame-regions","regions":[]}""")]
    [InlineData("""{"type":"frame-regions","regions":[],"colorScheme":"blue"}""")]
    [InlineData("""{"type":"other","regions":[],"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","regions":[],"colorScheme":"light","extra":1}""")]
    [InlineData("""{"type":"frame-regions","regions":{},"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","regions":[[0,0,10]],"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","regions":[[0,0,10,"1"]],"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","regions":[[0,0,-10,10]],"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","regions":[[0,0,1e9,10]],"colorScheme":"light"}""")]
    [InlineData("""{"type":"frame-regions","type":"frame-regions","regions":[],"colorScheme":"light"}""")]
    public void Rejects_anything_else(string? json) => Assert.Null(DesktopFrameRegions.Parse(json));

    [Fact]
    public void Rejects_more_than_the_region_limit()
    {
        string Message(int count) =>
            """{"type":"frame-regions","colorScheme":"light","regions":["""
            + string.Join(",", Enumerable.Repeat("[0,0,1,1]", count))
            + "]}";
        Assert.NotNull(DesktopFrameRegions.Parse(Message(DesktopFrameRegions.RegionLimit)));
        Assert.Null(DesktopFrameRegions.Parse(Message(DesktopFrameRegions.RegionLimit + 1)));
    }

    [Fact]
    public void Clipping_scales_bounds_and_keeps_the_window_controls_free()
    {
        // A drag gap that the page extended under the caption buttons and past the window edge.
        var message = new DesktopFrameRegions([new FrameRect(1100, 0, 200, 50), new FrameRect(-5, -5, 3, 3)], false);
        var clipped = message.Clip(
            1.5,
            new FrameRect(0, 0, 1920, 1200),
            [new FrameRect(0, 0, 0, 48), new FrameRect(1920 - 207, 0, 207, 48)]
        );
        Assert.Equal(
            [new FrameRect(1650, 48, 270, 27), new FrameRect(1650, 0, 63, 48)],
            clipped
        );
    }
}
