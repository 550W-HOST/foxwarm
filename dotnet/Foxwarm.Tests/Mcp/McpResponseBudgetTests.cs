using System.Text;
namespace Foxwarm.Tests;

public sealed class McpResponseBudgetTests
{
    [Theory]
    [InlineData("\n")]
    [InlineData("\r")]
    [InlineData("\r\n")]
    public void SubscriptionBudgetsEventsIndependentlyAcrossFragments(string end)
    {
        var stream = new McpResponseBudget("example", 32, sse: true, streamingGet: true);
        for (int i = 0; i < 12; i++)
            foreach (byte b in Encoding.UTF8.GetBytes("data: {}" + end + end)) stream.Read([b]);
        stream.Read("data: part one\r\ndata: "u8);
        Assert.Throws<InvalidDataException>(() => stream.Read("part two is over budget"u8));
    }

    [Fact]
    public void OrdinaryPostRetainsAnAggregateBoundAcrossSmallEvents()
    {
        var stream = new McpResponseBudget("example", 16, sse: true, streamingGet: false);
        stream.Read("data: 1\n\n"u8);
        Assert.Throws<InvalidDataException>(() => stream.Read("data: 2\n\n"u8));
    }
}
