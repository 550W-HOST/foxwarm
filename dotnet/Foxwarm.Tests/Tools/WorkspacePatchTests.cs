using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WorkspacePatchTests
{
    [Fact]
    public void Context_failure_retains_only_the_actual_hunk_after_an_earlier_match()
    {
        var patch = WorkspacePatch.Parse(
            "*** Begin Patch\n*** Update File: input.txt\n"
            + "@@\n-first\n+earlier-successful-addition\n"
            + "@@ repair-target\n-old-content-not-in-file\n+required-added-line-tail\n"
            + "@@ later-hunk\n-foot\n+later-addition-not-failed\n*** End Patch"
        ).Single();
        var error = Assert.Throws<InvalidDataException>(() => WorkspacePatch.Update(
            "first\nfile-content-not-in-patch\nfoot\n", patch.Lines, patch.Path
        ));
        Assert.Contains("@@ repair-target\n-old-content-not-in-file\n+required-added-line-tail", error.Message);
        Assert.DoesNotContain("earlier-successful-addition", error.Message);
        Assert.DoesNotContain("later-hunk", error.Message);
        Assert.DoesNotContain("later-addition-not-failed", error.Message);
        Assert.DoesNotContain("file-content-not-in-patch", error.Message);
        Assert.True(error.Message.Length <= 1600);
    }

    [Fact]
    public void Long_hunk_and_path_keep_failed_head_and_added_tail_within_the_error_budget()
    {
        var hunk = new[] { "@@ failed-head-anchor", "-missing-deletion" }
            .Concat(Enumerable.Range(0, 100).Select(i => " context-" + i + new string('x', 80)))
            .Append("+required-added-line-tail")
            .ToArray();
        var error = Assert.Throws<InvalidDataException>(() => WorkspacePatch.Update(
            "unrelated-file-preview\n", hunk, new string('p', 2000) + "-path-tail"
        ));
        Assert.Contains("@@ failed-head-anchor\n-missing-deletion", error.Message);
        Assert.EndsWith("+required-added-line-tail", error.Message);
        Assert.Contains("-path-tail", error.Message);
        Assert.Contains("middle of failed hunk omitted", error.Message);
        Assert.DoesNotContain("unrelated-file-preview", error.Message);
        Assert.True(error.Message.Length <= 1600);
    }

    [Fact]
    public void Eof_context_failure_preserves_original_context_and_edit_prefixes()
    {
        string[] hunk = ["@@", " retained-context", "-absent-ending", "+new-ending", "*** End of File"];
        var error = Assert.Throws<InvalidDataException>(() => WorkspacePatch.Update(
            "retained-context\nactual-ending", hunk, "input.txt"
        ));
        Assert.Contains("@@\n retained-context\n-absent-ending\n+new-ending", error.Message);
        Assert.EndsWith("*** End of File", error.Message);
        Assert.DoesNotContain("actual-ending", error.Message);
        Assert.True(error.Message.Length <= 1600);
    }
}
