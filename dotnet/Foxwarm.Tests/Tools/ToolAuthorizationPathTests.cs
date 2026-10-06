using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolAuthorizationPathTests
{
    private static ToolAuthorizationPolicy Policy(string path, string condition = "allWithin") =>
        ToolAuthorizationPolicy.Normalize(
            new JsonObject
            {
                ["version"] = 1,
                ["defaultAction"] = "deny",
                ["rules"] = new JsonArray(
                    new JsonObject
                    {
                        ["id"] = "physical",
                        ["action"] = "allow",
                        ["match"] = new JsonObject
                        {
                            ["path"] = new JsonObject { [condition] = path },
                        },
                    }
                ),
            }
        );

    [Fact]
    public void Actual_finite_literal_paths_policy_base_symlinks_and_nearest_existing_ancestors_match_the_same_physical_destination()
    {
        using var temp = new TempDirectory();
        var global = Path.Combine(temp.Path, "workspace");
        var own = Path.Combine(global, "agents", "alpha");
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(own, "allowed"));
        Directory.CreateDirectory(data);
        var files = new WorkspaceTools(own);
        Directory.CreateSymbolicLink(
            Path.Combine(global, "policy-base"),
            Path.Combine(own, "allowed")
        );
        var paths = files.AuthorizationFacts(
            "write",
            new JsonObject { ["filePath"] = "allowed/new/leaf", ["createDirs"] = true }
        );
        var request = new ToolAuthorizationRequest(
            "node",
            "write",
            null,
            new(),
            paths,
            "alpha",
            "opaque",
            "master",
            global,
            own,
            Path.Combine(own, "memory")
        );
        Assert.True(
            ToolAuthorizationEvaluation
                .Evaluate(Policy("${workspace}/policy-base"), request)
                .Allowed
        );
        Assert.False(ToolAuthorizationEvaluation.Evaluate(Policy(data), request).Allowed);
        var literal = files.AuthorizationFacts(
            "write",
            new JsonObject { ["filePath"] = "~/literal", ["createDirs"] = true }
        );
        Assert.Equal(
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "literal"
            ),
            Assert.Single(literal).Resolved
        );
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(Policy("${agent.dir}/~"), request with { Paths = literal })
                .Allowed
        );
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(Policy("${agent.memoryDir}"), request with { Paths = literal })
                .Allowed
        );
        Directory.CreateSymbolicLink(
            Path.Combine(own, "effect-link"),
            Path.Combine(own, "allowed")
        );
        Assert.Equal(
            Path.Combine(own, "allowed", "new"),
            Assert
                .Single(
                    files.AuthorizationFacts(
                        "write",
                        new JsonObject { ["filePath"] = "effect-link/new" }
                    )
                )
                .Resolved
        );
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(
                    Policy("${agent.dir}"),
                    request with
                    {
                        Source = "mcp",
                        Server = "peer",
                        Name = "read",
                        Paths = [],
                    }
                )
                .Allowed
        );
    }

    [Fact]
    public void Repeated_finite_real_symlink_traversal_is_not_a_cycle_and_true_link_cycles_fail_before_facts_are_used()
    {
        using var temp = new TempDirectory();
        var real = Path.Combine(temp.Path, "real");
        Directory.CreateDirectory(real);
        Directory.CreateSymbolicLink(Path.Combine(real, "again"), real);
        Assert.Equal(
            Path.Combine(real, "new", "leaf"),
            AuthorizationPaths.CanonicalPotential(
                Path.Combine(real, "again", "again", "new", "leaf")
            )
        );
        File.CreateSymbolicLink(Path.Combine(temp.Path, "one"), "two");
        File.CreateSymbolicLink(Path.Combine(temp.Path, "two"), "one");
        Assert.Throws<IOException>(() =>
            AuthorizationPaths.CanonicalPotential(Path.Combine(temp.Path, "one"))
        );
    }

    [Fact]
    public async Task Candidate_regular_file_bound_from_one_open_handle_follows_an_authorized_symlink_and_rejects_nonfiles_and_oversize()
    {
        using var temp = new TempDirectory();
        var files = new WorkspaceTools(temp.Path);
        var regular = Path.Combine(temp.Path, "candidate");
        var bytes = System.Text.Encoding.UTF8.GetBytes("# exact bytes\r\nversion: 1\r\n");
        await File.WriteAllBytesAsync(regular, bytes);
        Assert.Equal(
            bytes,
            await files.CapturePolicyCandidateAsync("candidate", CancellationToken.None)
        );
        Directory.CreateDirectory(Path.Combine(temp.Path, "directory"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            files.CapturePolicyCandidateAsync("directory", CancellationToken.None)
        );
        await File.WriteAllBytesAsync(regular, new byte[ToolAuthorizationPolicy.MaxBytes + 1]);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            files.CapturePolicyCandidateAsync("candidate", CancellationToken.None)
        );
        await File.WriteAllBytesAsync(regular, bytes);
        File.CreateSymbolicLink(Path.Combine(temp.Path, "link"), regular);
        Assert.Equal(
            bytes,
            await files.CapturePolicyCandidateAsync("link", CancellationToken.None)
        );
    }
}
