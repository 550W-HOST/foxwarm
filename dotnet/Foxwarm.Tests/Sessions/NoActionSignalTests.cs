using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class NoActionSignalTests
{
    [Fact]
    public void NoActionSignalUsesAnyTextPartAndAcceptsLegacyAndBracketedMarkers()
    {
        Assert.True(SessionBoundary.IsNoAction("NO_ACTION"));
        Assert.True(SessionBoundary.IsNoAction("[NO_ACTION]"));
        Assert.True(SessionBoundary.IsNoAction("summary\n[NO_ACTION]"));
        Assert.False(SessionBoundary.IsNoAction("summary only"));
    }

    [Theory]
    [InlineData("[NO_ACTION]\n\nTask is still blocked; nothing further to report.")]
    [InlineData("[NO_ACTION] nothing further")]
    [InlineData("Nothing further is needed. [NO_ACTION]")]
    [InlineData("  \n[NO_ACTION]\n\nstill blocked\n  ")]
    [InlineData("\n\tsummary\n[NO_ACTION] \n")]
    [InlineData(" \u00a0NO_ACTION\n")]
    public void NoActionSignalAcceptsMarkerAtStartOrEnd(string text)
    {
        Assert.True(SessionBoundary.IsNoAction(text));
    }

    [Theory]
    [InlineData("Please do not literally print [NO_ACTION] here.")]
    [InlineData("prefix [NO_ACTION] suffix")]
    [InlineData("Reminder: if nothing remains, reply [NO_ACTION] instead.\nDone.")]
    [InlineData("NO_ACTION follows")]
    [InlineData("[NO_ACTION")]
    [InlineData("   ")]
    [InlineData("")]
    [InlineData(null)]
    public void NoActionSignalRejectsMarkerInsideText(string? text)
    {
        Assert.False(SessionBoundary.IsNoAction(text));
    }
}
