using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using static Foxwarm.Tests.ApprovalStagingSupport;

namespace Foxwarm.Tests;

// Staged approval of set_config (phase 2): the candidate is a protected input whose content
// decides the call's secret facts.
public sealed partial class AgentRulesTreeTests
{
    private const string StagedConfigPolicy = """
        version: 1
        rules:
          - id: confirm-read
            action: ask
            tool: {source: node, name: read}
            approval: {timeoutSeconds: 900, approvers: [ops, reader]}
          - id: confirm-config
            action: ask
            tool: {source: builtin, name: set_config}
            approval: {timeoutSeconds: 600, approvers: [ops, config, admin]}
          - id: confirm-secret
            action: ask
            secrets: {anyOf: [provider-*]}
            approval: {timeoutSeconds: 300, approvers: [ops, config]}
        """;

    private static Task StagedPolicy(ExternalChannelFixture f, string yaml) =>
        f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);

    private static async Task<(ExternalChannelFixture F, string Candidate, string Redirected)> StagedConfigFixture()
    {
        var f = await ConfigurationFixture();
        f.Configuration.Secrets.Store.Set("provider-key", "synthetic-provider-secret-0101");
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ProviderModels });
        var candidate = Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "models.yaml");
        Directory.CreateDirectory(Path.GetDirectoryName(candidate)!);
        // Sending the stored key to another base URL is a new destination for it.
        var redirected = ProviderModels.Replace("127.0.0.1:1", "127.0.0.1:2", StringComparison.Ordinal);
        await File.WriteAllTextAsync(candidate, redirected);
        return (f, candidate, redirected);
    }

    private static JsonObject ModelsCall(string candidate) =>
        new() { ["target"] = "models", ["filePath"] = candidate };

    [Fact]
    public async Task Asking_candidate_read_then_discovered_secret_ask_are_two_approvals_with_their_own_approvers()
    {
        var (f, candidate, _) = await StagedConfigFixture();
        await using var fixture = f;
        await StagedPolicy(f, StagedConfigPolicy);
        var call = f.ToolAsync("set_config", ModelsCall(candidate));

        // Stage A: only the read of the candidate, before its content is known.
        var input = await PendingAsync(f.Owner);
        Assert.Equal("input", input["stage"]!.GetValue<string>());
        Assert.Equal("set_config", input["tool"]!["name"]!.GetValue<string>());
        Assert.Equal(["candidate-read"], CheckIds(input));
        Assert.Equal(["ops", "reader"], Approvers(input));
        Assert.Equal(900, input["timeoutSeconds"]!.GetValue<long>());
        Assert.Null(input["facts"]);
        await Approve(f.Manager, f.Owner, input);

        // Stage B: the call with the secret facts its admitted candidate revealed. The asking
        // call rule and secret rule intersect; the approved read is not asked again.
        var plan = await PendingAsync(f.Owner, Id(input));
        Assert.Null(plan["stage"]);
        Assert.Empty(CheckIds(plan));
        Assert.Equal(["provider-key"], plan["facts"]!["secrets"]!.AsArray().Select(item => item!.GetValue<string>()));
        Assert.Equal(["config", "ops"], Approvers(plan));
        Assert.Equal(300, plan["timeoutSeconds"]!.GetValue<long>());
        await Approve(f.Manager, f.Owner, plan);

        Successful(await call.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Contains("127.0.0.1:2", File.ReadAllText(f.Configuration.ActivePath));
        Assert.Equal(2, Records(f.Owner).Length);
    }

    [Fact]
    public async Task Denied_candidate_read_stops_the_call_before_its_content_is_derived()
    {
        var (f, candidate, _) = await StagedConfigFixture();
        await using var fixture = f;
        await StagedPolicy(
            f,
            StagedConfigPolicy.Replace(
                "  - id: confirm-read\n    action: ask",
                "  - id: confirm-read\n    action: deny",
                StringComparison.Ordinal
            ).Replace("    approval: {timeoutSeconds: 900, approvers: [ops, reader]}\n", "", StringComparison.Ordinal)
        );
        var before = File.ReadAllText(f.Configuration.ActivePath);
        var result = await f.ToolAsync("set_config", ModelsCall(candidate));
        Assert.Equal("tool_authorization_denied", ErrorType(result));
        Assert.Contains("`confirm-read`", SessionWait.Text(result?["error"]?["message"]));
        // No approval was requested, neither for the read nor for the call.
        Assert.Empty(Records(f.Owner));
        Assert.Equal(before, File.ReadAllText(f.Configuration.ActivePath));
    }

    [Fact]
    public async Task Candidate_changed_after_its_input_approval_is_not_installed()
    {
        var (f, candidate, _) = await StagedConfigFixture();
        await using var fixture = f;
        await StagedPolicy(f, StagedConfigPolicy);
        var call = f.ToolAsync("set_config", ModelsCall(candidate));
        var input = await PendingAsync(f.Owner);
        await Approve(f.Manager, f.Owner, input);
        var plan = await PendingAsync(f.Owner, Id(input));
        // The file changes after its bytes were admitted and the plan was derived from them.
        await File.WriteAllTextAsync(
            candidate,
            ProviderModels.Replace("127.0.0.1:1", "127.0.0.1:3", StringComparison.Ordinal)
        );
        await Approve(f.Manager, f.Owner, plan);
        Successful(await call.WaitAsync(TimeSpan.FromSeconds(30)));
        var installed = File.ReadAllText(f.Configuration.ActivePath);
        Assert.Contains("127.0.0.1:2", installed);
        Assert.DoesNotContain("127.0.0.1:3", installed);
    }

    [Fact]
    public async Task Changed_destination_secrets_at_installation_fail_closed_without_installing()
    {
        var (f, candidate, redirected) = await StagedConfigFixture();
        await using var fixture = f;
        await StagedPolicy(f, StagedConfigPolicy);
        var files = f.Manager.IdentityWorkspace(f.Owner);
        var args = ModelsCall(candidate);
        var resolved = new ResolvedTool("set_config", "builtin", "set_config", args);
        // Run the gate's stages under one scope, granting each stage as an approver would.
        var scope = new ToolApprovalScope(f.Owner) { Primary = resolved };
        using var entered = ToolApprovalScope.Enter(scope);
        var stages = new List<ToolApprovalStage>();
        while (true)
            try
            {
                await f.Manager.AuthorizeCallAsync(f.Owner, resolved, files, "master", default);
                break;
            }
            catch (ToolApprovalRequiredException required)
            {
                stages.Add(required.Stage);
                scope.Add(
                    new(
                        "ap-" + stages.Count,
                        required.Checks.Select(check => check.Fingerprint).ToHashSet(),
                        null,
                        required.Stage
                    )
                );
            }
        Assert.Equal([ToolApprovalStage.Input, ToolApprovalStage.Call], stages);
        // The installed configuration now already sends the key there: the candidate's secret
        // facts differ from those approved.
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = redirected.Replace("[wire]", "[wire, extra]", StringComparison.Ordinal) });
        var before = File.ReadAllText(f.Configuration.ActivePath);
        var error = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.InstallConfigAsync(f.Owner, files, args, default)
        );
        Assert.Equal("tool_approval_unavailable", error.ErrorType);
        Assert.Equal(before, File.ReadAllText(f.Configuration.ActivePath));
    }
}
