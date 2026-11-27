namespace Foxwarm.Tests;

public sealed class DesktopDownloadPolicyTests
{
    private static readonly Uri Local = new("http://127.0.0.1:49152/");
    private static readonly Uri Remote = new("https://lab.example/foxwarm/");

    [Theory]
    // HTTP(S) downloads must be in the scope, whatever page asks for them.
    [InlineData("http://127.0.0.1:49152/download?path=%2Fa.txt&sig=x", "http://127.0.0.1:49152/", true)]
    [InlineData("http://127.0.0.1:49152/api/blobs/b/download", null, true)]
    [InlineData("https://example.com/file.zip", "http://127.0.0.1:49152/", false)]
    [InlineData("http://127.0.0.1:49153/file.zip", "http://127.0.0.1:49152/", false)]
    [InlineData("http://localhost:49152/file.zip", "http://127.0.0.1:49152/", false)]
    // blob: URLs carry their creator's origin, and the requesting page must be in the scope.
    [InlineData("blob:http://127.0.0.1:49152/0f8e2d1c-6a1b-4b0e-9a55-2f9f6a0e1d2c", "http://127.0.0.1:49152/vscode-web/?nodeId=master", true)]
    [InlineData("blob:http://127.0.0.1:49152/0f8e2d1c", "about:blank", true)]
    [InlineData("blob:http://127.0.0.1:49152/0f8e2d1c", "https://example.com/", false)]
    [InlineData("blob:http://127.0.0.1:49152/0f8e2d1c", null, false)]
    [InlineData("blob:https://example.com/0f8e2d1c", "http://127.0.0.1:49152/", false)]
    [InlineData("blob:null/0f8e2d1c", "http://127.0.0.1:49152/", false)]
    [InlineData("data:application/json;base64,e30=", "http://127.0.0.1:49152/", true)]
    [InlineData("DATA:text/plain,hi", "http://127.0.0.1:49152/?foxwarmPopup=tasks", true)]
    [InlineData("data:text/plain,hi", "https://example.com/", false)]
    [InlineData("data:text/plain,hi", "", false)]
    [InlineData("about:blank", "http://127.0.0.1:49152/", false)]
    [InlineData("file:///etc/passwd", "http://127.0.0.1:49152/", false)]
    [InlineData("foxwarm://node+master/tmp/a.bin", "http://127.0.0.1:49152/vscode-web/", false)]
    [InlineData("javascript:alert(1)", "http://127.0.0.1:49152/", false)]
    [InlineData("", "http://127.0.0.1:49152/", false)]
    [InlineData(null, "http://127.0.0.1:49152/", false)]
    public void Allows_downloads_only_from_the_local_scope(string? url, string? page, bool expected) =>
        Assert.Equal(expected, DesktopDownloadPolicy.Allows(Local, url, page));

    [Theory]
    [InlineData("https://lab.example/foxwarm/download?path=a", "https://lab.example/foxwarm/", true)]
    [InlineData("https://lab.example/foxwarm-other/a.zip", "https://lab.example/foxwarm/", false)]
    [InlineData("https://lab.example/a.zip", "https://lab.example/foxwarm/", false)]
    [InlineData("blob:https://lab.example/0f8e2d1c", "https://lab.example/foxwarm/vscode-web/", true)]
    [InlineData("blob:https://lab.example/0f8e2d1c", "https://lab.example/other/", false)]
    [InlineData("blob:http://lab.example/0f8e2d1c", "https://lab.example/foxwarm/", false)]
    [InlineData("data:text/plain,hi", "https://lab.example/foxwarm", true)]
    public void Allows_downloads_only_from_a_remote_scope(string url, string page, bool expected) =>
        Assert.Equal(expected, DesktopDownloadPolicy.Allows(Remote, url, page));

    [Fact]
    public void Accepts_a_data_url_longer_than_Uri_allows()
    {
        var url = "data:application/octet-stream;base64," + new string('A', 200_000);
        Assert.True(DesktopDownloadPolicy.Allows(Local, url, "http://127.0.0.1:49152/"));
    }

    [Theory]
    [InlineData("attachment", true)]
    [InlineData("attachment; filename=\"a.txt\"", true)]
    [InlineData("  Attachment ;filename*=UTF-8''a%20b.txt", true)]
    [InlineData("inline; filename=\"a.png\"", false)]
    [InlineData("attachments", false)]
    [InlineData("filename=attachment", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Recognizes_attachment_dispositions(string? header, bool expected) =>
        Assert.Equal(expected, DesktopDownloadPolicy.IsAttachment(header));

    [Theory]
    [InlineData("report.pdf", "report.pdf")]
    [InlineData("a/b\\c:d.txt", "a_b_c_d.txt")]
    [InlineData("tab\there.txt", "tab_here.txt")]
    [InlineData(".bashrc", "bashrc")]
    [InlineData("  ..hidden.txt  ", "hidden.txt")]
    [InlineData("中文 名.md", "中文 名.md")]
    [InlineData("", "download")]
    [InlineData("...", "download")]
    [InlineData(null, "download")]
    public void Sanitizes_suggested_names(string? suggested, string expected) =>
        Assert.Equal(expected, DesktopDownloadPolicy.FileName(suggested));

    [Fact]
    public void Keeps_the_extension_of_a_long_name_within_255_bytes()
    {
        var name = DesktopDownloadPolicy.FileName(new string('名', 200) + ".tar.gz");
        Assert.EndsWith(".tar.gz", name);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(name) <= 255);
        Assert.StartsWith("名", name);
    }

    [Theory]
    [InlineData("a.txt", new string[0], "a.txt")]
    [InlineData("a.txt", new[] { "a.txt" }, "a 2.txt")]
    [InlineData("a.txt", new[] { "a.txt", "a 2.txt" }, "a 3.txt")]
    [InlineData("archive.tar.gz", new[] { "archive.tar.gz" }, "archive 2.tar.gz")]
    [InlineData("README", new[] { "README" }, "README 2")]
    [InlineData("v1.2.zip", new[] { "v1.2.zip" }, "v1.2 2.zip")]
    public void Names_copies_the_way_Finder_does(string name, string[] taken, string expected)
    {
        var directory = Path.Combine(Path.GetTempPath(), "downloads");
        var names = taken.Select(item => Path.Combine(directory, item)).ToHashSet();
        Assert.Equal(expected, DesktopDownloadPolicy.UniqueName(directory, name, names.Contains));
    }
}
