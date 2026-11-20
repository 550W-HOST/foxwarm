using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // The packaged agent-management templates, as administrators copy them into create_agent.
    private static JsonArray ShippedRules(string name) =>
        Rules(
            File.ReadAllText(
                Path.Combine(
                    AppContext.BaseDirectory,
                    "skills",
                    "agent-management",
                    "references",
                    "memory-templates",
                    name
                )
            )
        );

    private static ResolvedTool Call(string source, string name, string args, string node = "master") =>
        new(name, source, name, Obj(args), null, node);

    [Fact]
    public async Task Shipped_restricted_worker_rules_confine_workers_to_their_current_Node_parent_and_own_Tasks()
    {
        await using var f = await Fixture();
        await ChildAgent(f, "worker", rules: ShippedRules("restricted-worker.rules.json"));
        var coordinator = f.Owner;
        var worker = (
            await f.Manager.CreateChildAsync(
                coordinator,
                "task-1",
                "worker",
                null,
                null,
                null,
                initialNode: "sandbox-task-1"
            )
        ).Child;
        var peer = (
            await f.Manager.CreateChildAsync(
                coordinator,
                "task-2",
                "worker",
                null,
                null,
                null,
                initialNode: "sandbox-task-2"
            )
        ).Child;
        var onMaster = await f.Manager.CreateNamedAsync(
            "worker",
            "placed-on-master",
            null,
            null,
            initialNode: "master"
        );
        Task Allow(SessionOwner owner, ResolvedTool tool) =>
            f.Manager.AuthorizeToolAsync(owner, tool, null, default);
        Task Deny(SessionOwner owner, ResolvedTool tool) =>
            Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => Allow(owner, tool));

        await Allow(worker, Call("node", "exec", """{"command":"true"}""", "sandbox-task-1"));
        await Allow(worker, Call("node", "read", """{"filePath":"a"}""", "sandbox-task-1"));
        await Deny(worker, Call("node", "exec", """{"command":"true"}""", "sandbox-task-2"));
        // Node selectors also match the node builtin's concrete targets; the rule's node-source scope excludes them.
        foreach (var action in new[] { "select", "inspect", "destroy" })
            await Deny(
                worker,
                Call(
                    "builtin",
                    "node",
                    $$"""{"action":"{{action}}","nodeId":"sandbox-task-1","confirmation":"destroy node sandbox-task-1"}"""
                )
            );
        await Deny(
            worker,
            Call(
                "builtin",
                "copy_between_nodes",
                """{"sourceNode":"sandbox-task-1","sourcePath":"a","targetNode":"sandbox-task-1","targetPath":"b"}"""
            )
        );
        // Current-Node allowance would otherwise cover master for a Session placed there.
        Assert.Equal("master", f.Manager.CurrentNode(onMaster));
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            f.Manager.AuthorizeToolAsync(
                onMaster,
                Call("node", "exec", """{"command":"true"}"""),
                new WorkspaceTools(f.Manager.IdentityWorkspace(onMaster).ToolDirectory),
                default
            )
        );

        foreach (var memory in new[] { "write_memory", "edit_memory", "delete_memory" })
            await Deny(worker, Call("builtin", memory, """{"filePath":"MEMORY.md","content":"x"}"""));
        await Deny(
            worker,
            Call(
                "builtin",
                "apply_patch_memory",
                """{"input":"*** Begin Patch\n*** Add File: NOTE.md\n+x\n*** End Patch"}"""
            )
        );
        await Deny(worker, Call("builtin", "ask_user", """{"question":"Which?"}"""));
        await Deny(worker, Call("builtin", "create_session", """{"agentName":"worker"}"""));

        await Allow(
            worker,
            Call("builtin", "send_to_session", $$"""{"sessionId":"{{coordinator.Id}}"}""")
        );
        await Deny(worker, Call("builtin", "send_to_session", $$"""{"sessionId":"{{peer.Id}}"}"""));
        await Allow(
            worker,
            Call("builtin", "task", $$"""{"action":"create","ownerSessionId":"{{coordinator.Id}}"}""")
        );
        await Deny(
            worker,
            Call("builtin", "task", $$"""{"action":"create","ownerSessionId":"{{peer.Id}}"}""")
        );
        await Deny(worker, Call("builtin", "task", """{"action":"create"}"""));

        var assigned = await f.Manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "assignment",
                ["ownerSessionId"] = worker.Id,
                ["notifySession"] = false,
            },
            coordinator.Id
        );
        var taskId = SessionWait.Text(assigned.Payload["task"]?["id"]);
        await Allow(
            worker,
            Call("builtin", "task", $$"""{"action":"complete","taskId":"{{taskId}}"}""")
        );
        await Deny(peer, Call("builtin", "task", $$"""{"action":"complete","taskId":"{{taskId}}"}"""));
        await Allow(worker, Call("builtin", "recall", """{"target":"msg#1"}"""));
        await Deny(worker, Call("builtin", "recall", $$"""{"sessionId":"{{peer.Id}}"}"""));
        await Allow(worker, Call("builtin", "skill", """{"action":"list"}"""));
        await Allow(worker, Call("builtin", "wait", """{"waitForInput":true}"""));
    }

    [Fact]
    public async Task Shipped_channel_assistant_rules_allow_current_Node_tools_and_files_to_its_own_conversation()
    {
        await using var f = await Fixture();
        await ChildAgent(f, "assistant", rules: ShippedRules("channel-assistant.rules.json"));
        var chat = await f.Manager.CreateNamedAsync(
            "assistant",
            "chat",
            null,
            null,
            initialNode: "assistant-node"
        );
        var other = await f.Manager.CreateNamedAsync("assistant", "other", null, null);
        Task Allow(ResolvedTool tool) => f.Manager.AuthorizeToolAsync(chat, tool, null, default);
        Task Deny(ResolvedTool tool) =>
            Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => Allow(tool));

        await Allow(Call("node", "exec", """{"command":"true"}""", "assistant-node"));
        await Allow(Call("builtin", "send_file", """{"filePath":"report.pdf"}""", "assistant-node"));
        await Deny(
            Call(
                "builtin",
                "send_file",
                $$"""{"filePath":"report.pdf","sessionId":"{{other.Id}}"}""",
                "assistant-node"
            )
        );
        await Deny(
            Call(
                "builtin",
                "send_file",
                """{"filePath":"report.pdf","channelTargetId":"chat:room"}""",
                "assistant-node"
            )
        );
        await Deny(Call("builtin", "node", """{"action":"destroy","nodeId":"assistant-node"}"""));
        await Deny(Call("builtin", "send_to_session", $$"""{"sessionId":"{{f.Owner.Id}}"}"""));
        await Deny(Call("builtin", "write_memory", """{"filePath":"MEMORY.md","content":"x"}"""));

        // Inbound files of an Agent without legacy isolation are saved on master under its directory.
        var paths = new WorkspaceTools(f.Manager.IdentityWorkspace(chat).ToolDirectory);
        var received = Path.Combine(
            f.Manager.AgentDirectory("assistant"),
            ".temp",
            "channel-files",
            "telegram",
            "doc.txt"
        );
        Task OnMaster(string name, string path) =>
            f.Manager.AuthorizeToolAsync(
                chat,
                Call("node", name, new JsonObject { ["filePath"] = path }.ToJsonString()),
                paths,
                default
            );
        await OnMaster("read", received);
        foreach (
            var outside in new[]
            {
                Path.Combine(f.Manager.AgentDirectory("assistant"), "secret.txt"),
                Path.Combine(
                    f.Manager.AgentDirectory("assistant"),
                    ".temp",
                    "channel-files",
                    "..",
                    "secret.txt"
                ),
            }
        )
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => OnMaster("read", outside));
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => OnMaster("write", received));
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            f.Manager.AuthorizeToolAsync(
                chat,
                Call("node", "exec", """{"command":"cat doc.txt"}"""),
                paths,
                default
            )
        );
    }
}
