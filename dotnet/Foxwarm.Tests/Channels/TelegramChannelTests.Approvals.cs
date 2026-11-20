using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The channel notice of a pending approval: channels cannot decide, they only learn that the
// WebUI has a request, and how much one approval covers.
public sealed partial class TelegramChannelTests
{
    [Fact]
    public async Task Approval_notice_names_the_call_and_what_else_one_approval_covers()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel("a") },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:-100", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n- {id: confirm-write, tool: {source: node, name: write}, action: ask}\n- {id: confirm-read, tool: {source: node, name: read}, action: ask}\n"
            ),
            default
        );
        var files = f.Manager.IdentityWorkspace(f.Owner);
        var write = new ResolvedTool(
            "write",
            "node",
            "write",
            new JsonObject { ["filePath"] = "a.txt", ["content"] = "x" }
        );
        var read = new ResolvedTool("read", "node", "read", new JsonObject { ["filePath"] = "b.txt" });
        var writeAssessment = await f.Manager.AssessToolAsync(f.Owner, write, files, default);
        var readAssessment = await f.Manager.AssessToolAsync(f.Owner, read, files, default);
        IEnumerable<string> Texts() =>
            peer.Sent("a").Select(call => SessionWait.Text(call.Body["text"]) ?? "");

        async Task<string> Notice(ToolApprovalRequiredException required, string expected)
        {
            var pending = await f.Manager.BeginToolApprovalAsync(
                f.Owner,
                required,
                new("turn", "call-" + Guid.NewGuid().ToString("N"), null),
                unattended: false
            );
            await Until(() => Texts().Any(text => text.Contains(expected, StringComparison.Ordinal)));
            await f.Manager.DecideToolApprovalAsync(
                f.Owner,
                pending.Id,
                false,
                null,
                new JsonObject { ["kind"] = "administrator" }
            );
            return Texts().Last(text => text.Contains(expected, StringComparison.Ordinal));
        }

        var single = await Notice(
            new ToolApprovalRequiredException(writeAssessment, write, "fp-write"),
            "A tool call is waiting for approval in the WebUI: `write`"
        );
        Assert.DoesNotContain("also covers", single, StringComparison.Ordinal);
        var combined = await Notice(
            new ToolApprovalRequiredException(
                [
                    new("primary", write, writeAssessment, "fp-write", true),
                    new("source-read", read, readAssessment, "fp-read", false),
                ],
                write,
                ToolApprovalStage.Call,
                writeAssessment.Request
            ),
            "(also covers 1 related check)"
        );
        Assert.StartsWith("A tool call is waiting for approval in the WebUI: `write` — ", combined);
        var input = await Notice(
            new ToolApprovalRequiredException(
                [new("candidate-read", read, readAssessment, "fp-read", false)],
                write,
                ToolApprovalStage.Input
            ),
            "to read its input"
        );
        Assert.StartsWith(
            "A tool call is waiting for approval in the WebUI to read its input: `write` — ",
            input
        );
    }
}
