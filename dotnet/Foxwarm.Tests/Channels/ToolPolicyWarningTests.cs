namespace Foxwarm.Tests.Channels;

[Collection("Process console")]
public sealed class ToolPolicyWarningTests
{
    [Fact]
    public void TwoPolicyOwnersCanEachReportTheSameWarning()
    {
        using var temp = new TempDirectory();
        var before = Console.Error;
        using var output = new StringWriter();
        try
        {
            Console.SetError(output);
            foreach (var tenant in new[] { "alpha", "beta" })
            {
                var root = Path.Combine(temp.Path, tenant);
                Directory.CreateDirectory(Path.Combine(root, "state"));
                var time = 0L;
                var authority = new Foxwarm.Tools.ToolAuthorizationAuthority(root, clock: () => time);
                File.WriteAllText(authority.PolicyPath!, "version: 1\nrules:\n- action: allow\n  tool: search_tools\n");
                authority.Load();
                time += 20_000;
                authority.Load();
            }
            Assert.Equal(2, output.ToString().Split('\n').Count(line => line.Contains("builtin search_tools")));
        }
        finally { Console.SetError(before); }
    }

}
