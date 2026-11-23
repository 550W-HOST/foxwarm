namespace Foxwarm.Tools;

// The obligation inventory: every authorization call site outside the dispatch gate and the
// declared obligations it checks. OperationDeclarationCoverageTests enumerates the call sites in
// the source and requires this list to match them exactly, and every declared sub-request,
// policy probe and retained final request to have a site.
internal static partial class OperationDeclarations
{
    private static ObligationSite Site(
        string file,
        string member,
        int ordinal,
        string call,
        params string[] obligations
    ) =>
        new(
            file,
            member,
            ordinal,
            call,
            obligations
                .Select(item =>
                {
                    var hash = item.LastIndexOf('#');
                    return (item[..hash], item[(hash + 1)..]);
                })
                .ToArray()
        );

    private const string Agent = "Sessions/SessionManager.AgentTools.cs";
    private const string Auth = "Sessions/SessionManager.Authorization.cs";
    private const string Staging = "Sessions/SessionManager.ApprovalPlan.cs";
    private const string Explain = "Sessions/SessionManager.AuthorizationExplain.cs";
    private const string Secrets = "Sessions/SessionManager.Secrets.cs";
    private const string Timers = "Sessions/SessionManager.Timers.cs";
    private const string Recall = "Sessions/Compaction/ArchiveRecallTool.cs";
    private const string Plan = "Sessions/Compaction/CompactPlanInput.cs";
    private const string Output = "Tools/SessionToolExecutor.Output.cs";
    private const string Script = "Tools/SessionToolExecutor.ToolScript.cs";
    private const string ScriptModel = "Sessions/SessionManager.ToolScript.cs";
    private const string Executor = "Tools/SessionToolExecutor.cs";
    private const string Tool = "AuthorizeToolAsync";
    private const string File = "AuthorizeNodeFileAsync";
    private const string Assess = "AssessToolAsync";

    internal static readonly IReadOnlyList<ObligationSite> Inventory =
    [
        Site("Sessions/SessionManager.AgentOps.cs", "SendAsync", 1, Tool, "builtin:send_to_session#primary"),
        Site(
            Agent,
            "ExecuteAgentToolCoreAsync",
            1,
            Tool,
            "builtin:move_session#primary",
            "builtin:delete_session#primary",
            "builtin:create_agent#primary",
            "builtin:create_session#primary",
            "builtin:create_child_session#primary",
            "builtin:send_to_session#primary",
            "builtin:refresh_session_snapshot#primary",
            "builtin:skill#primary",
            "builtin:set_agent_inherit#primary",
            "builtin:set_agent_rules#primary",
            "builtin:session#primary",
            "builtin:set_session_model#primary",
            "builtin:set_session_child_model#primary",
            "builtin:set_session_compact_threshold#primary",
            "builtin:compact_session#primary"
        ),
        Site(Auth, "SecretFactsAsync", 1, Assess, "builtin:set_config#candidate-read"),
        Site(
            Staging,
            "RequireCreationTargetAsync",
            1,
            "AuthorizeCreateSessionTargetAsync",
            "builtin:create_timer#creation-target"
        ),
        Site(Auth, "SetAgentRulesAsync", 1, Tool, "builtin:set_agent_rules#primary"),
        Site(Auth, "AuthorizePromptFilesAsync", 1, Tool, "builtin:create_session#prompt-file-read"),
        Site(Auth, "InstallConfigAsync", 1, Tool, "builtin:set_config#primary", "builtin:set_config#install"),
        Site(Auth, "InstallConfigAsync", 2, Tool, "builtin:set_config#candidate-read"),
        Site(Explain, "ExplainToolAuthorizationAsync", 1, Tool, "builtin:explain_tool_authorization#policy-read"),
        Site(
            Explain,
            "ExplainToolAuthorizationAsync",
            2,
            Tool,
            "builtin:explain_tool_authorization#candidate-read"
        ),
        Site(Explain, "ExplainProbeAsync", 1, Tool, "builtin:explain_tool_authorization#probe-view"),
        Site(
            "Sessions/SessionManager.ChannelDelivery.cs",
            "SendToChannelAsync",
            1,
            Tool,
            "builtin:send_to_channel#primary"
        ),
        Site(
            "Sessions/SessionManager.CopyTransfers.cs",
            "CopyTransferCoreAsync",
            1,
            Tool,
            "builtin:copy_between_nodes#transfer"
        ),
        Site("Sessions/SessionManager.FileDelivery.cs", "SendFileAsync", 1, Tool, "builtin:send_file#primary"),
        Site(
            "Sessions/SessionManager.FileDelivery.cs",
            "ExportImageAsync",
            1,
            Tool,
            "builtin:image_write_to_file#primary"
        ),
        Site(
            "Sessions/SessionManager.McpNotifications.cs",
            "ManageMcpNotificationsAsync",
            1,
            Tool,
            "builtin:mcp_notifications#primary"
        ),
        Site(
            "Sessions/SessionManager.McpNotifications.cs",
            "ManageMcpNotificationsAsync",
            2,
            "EffectiveDecision",
            "builtin:mcp_notifications#reception"
        ),
        Site(
            "Sessions/SessionManager.McpNotifications.cs",
            "ManageMcpNotificationsAsync",
            3,
            Tool,
            "builtin:mcp_notifications#reception"
        ),
        Site(
            "Sessions/SessionManager.NodeCredentials.cs",
            "CreateNodeAuthTokenAsync",
            1,
            Tool,
            "builtin:node_create_auth_token#primary"
        ),
        Site(
            "Sessions/SessionManager.NodeLifecycle.cs",
            "ExecuteNodeToolAsync",
            1,
            Tool,
            "builtin:node#lifecycle-final"
        ),
        Site("Sessions/SessionManager.Nodes.cs", "SelectNodeAsync", 1, Tool, "builtin:node#default-cwd"),
        Site("Sessions/SessionManager.Nodes.cs", "RemoveNodeAsync", 1, Tool, "builtin:node_remove#member"),
        Site(Secrets, "AddSecretAsync", 1, File, "builtin:add_secret#file-read"),
        Site(Secrets, "AddSecretAsync", 2, Tool, "builtin:add_secret#delete-file"),
        Site(Secrets, "AddSecretAsync", 3, Tool, "builtin:add_secret#store"),
        Site(Secrets, "MoveSecretLiteralAsync", 1, Tool, "builtin:add_secret#config-read"),
        Site(Secrets, "MoveSecretLiteralAsync", 2, Tool, "builtin:add_secret#store"),
        Site(
            Timers,
            "ExecuteTimerAsync",
            1,
            Tool,
            "builtin:create_timer#primary",
            "builtin:update_timer#primary",
            "builtin:delete_timer#primary"
        ),
        Site(
            Timers,
            "ExecuteTimerAsync",
            2,
            "AuthorizeCreateSessionTargetAsync",
            "builtin:create_timer#creation-target",
            "builtin:update_timer#creation-target"
        ),
        Site(
            Timers,
            "ExecuteTimerAsync",
            3,
            Tool,
            "builtin:create_timer#primary",
            "builtin:update_timer#primary"
        ),
        Site("Sessions/SessionManager.cs", "SessionManager", 1, File, "node:edit#legacy-source-read"),
        Site("Sessions/SessionObservation.cs", "ObserveAsync", 1, Tool, "builtin:view_session#primary"),
        Site(
            "Sessions/Compaction/ArchiveControlTools.cs",
            "StopAsync",
            1,
            Tool,
            "builtin:stop_session#primary"
        ),
        Site(
            "Sessions/Compaction/ArchiveControlTools.cs",
            "AuthorizeArchiveAsync",
            1,
            Tool,
            "builtin:get_archived_messages#primary",
            "builtin:get_archived_blocks#primary"
        ),
        Site(Recall, "ExecuteAsync", 1, Tool, "builtin:recall#primary"),
        Site(Recall, "ExecuteAsync", 2, Tool, "builtin:recall#primary"),
        Site(Recall, "ExecuteAsync", 3, Tool, "builtin:recall#primary"),
        Site(Recall, "ExecuteAsync", 4, Tool, "builtin:recall#primary"),
        Site(Plan, "ReadAsync", 1, File, "builtin:submit_compact_plan#plan-read"),
        Site(
            Plan,
            "ExecuteAsync",
            1,
            Tool,
            "builtin:submit_compact_plan#plan-save",
            "builtin:submit_compact_plan#plan-repair"
        ),
        Site(
            "Tools/SessionToolExecutor.Artifact.cs",
            "ExecuteArtifactAsync",
            1,
            Tool,
            "builtin:artifact#source-read"
        ),
        Site(
            ScriptModel,
            "AssessToolScriptModelAsync",
            1,
            Assess,
            "builtin:run_script#model-request",
            "builtin:start_toolscript_run#model-request",
            "builtin:continue_script#model-request",
            "builtin:run_skill#model-request"
        ),
        Site(Output, "SaveToolOutputAsync", 1, File, "*#output-spill"),
        Site(Output, "SaveToolOutputAsync", 2, File, "*#output-spill"),
        Site(Output, "SaveToolOutputAsync", 3, File, "*#output-spill"),
        Site(
            Script,
            "ExecuteToolScriptAsync",
            1,
            File,
            "builtin:run_script#source-read",
            "builtin:start_toolscript_run#source-read"
        ),
        Site(
            Script,
            "ExecuteToolScriptAsync",
            2,
            Tool,
            "builtin:run_script#source-read",
            "builtin:start_toolscript_run#source-read"
        ),
        Site(Executor, "CreateRegistry", 1, "registry.ExecuteAsync", "builtin:add_secret#delete-file"),
        Site(Executor, "CreateRegistry", 2, Tool, "builtin:mcp_config#install"),
    ];

    private const string Require = "authorization.Require";
    private const string RequireAsync = "authorization.RequireAsync";

    // Inbound MCP enforcement: each external action's check, before its effect and again where
    // the action rechecks (completion, pairing, sending). They check the capability's own
    // request as McpExternalAuthorization builds it; mapping inbound actions to operations is
    // phase 3. External denials stay the generic "Tool action is not permitted."
    internal static readonly IReadOnlyList<ObligationSite> Inbound =
    [
        Site("McpClient.External.cs", "CallExternalAsync", 1, RequireAsync, "mcp:*#primary"),
        Site("McpClient.External.cs", "CallExternalAsync", 2, Require, "mcp:*#primary"),
        Site(
            "McpInboundCatalog.cs",
            "PairAsync",
            1,
            RequireAsync,
            "builtin:node_pair_list#primary",
            "builtin:node_pair_approve#primary"
        ),
        Site("McpInboundCatalog.cs", "PairAsync", 2, Require, "builtin:node_pair_approve#primary"),
        Site("McpInboundNodes.cs", "CallAsync", 1, RequireAsync, "node:*#primary"),
        Site("McpInboundNodes.cs", "CallAsync", 2, Require, "node:*#primary"),
        Site("McpInboundNodes.cs", "ResultAsync", 1, RequireAsync, "node:*#primary"),
        Site("McpInboundNodes.cs", "ResultAsync", 2, Require, "node:*#primary"),
        Site("McpInboundNodes.cs", "ResultAsync", 3, Require, "node:*#primary"),
        Site("McpInboundNodes.cs", "ResultAsync", 4, Require, "node:*#primary"),
        Site("McpInboundNodes.cs", "ActionAsync", 1, RequireAsync, "builtin:node#primary"),
        Site("McpInboundNodes.cs", "ActionAsync", 2, Require, "builtin:node#primary"),
        Site("McpInboundNodes.cs", "ActionAsync", 3, Require, "builtin:node#primary"),
        Site("McpInboundSessions.cs", "ListAsync", 1, RequireAsync, "builtin:session#primary"),
        Site("McpInboundSessions.cs", "ListAsync", 2, Require, "builtin:session#primary"),
        Site("McpInboundSessions.cs", "ReadAsync", 1, RequireAsync, "builtin:view_session#primary"),
        Site("McpInboundSessions.cs", "ReadAsync", 2, Require, "builtin:view_session#primary"),
        Site("McpInboundSessions.cs", "SendAsync", 1, RequireAsync, "builtin:send_to_session#primary"),
        Site("McpInboundSessions.cs", "SendAsync", 2, Require, "builtin:send_to_session#primary"),
    ];


    // The only direct callers of the evaluator.
    internal static readonly IReadOnlyList<(string File, string Member, string Reason)> EvaluatorPlumbing =
    [
        (Auth, "AssessToolAsync", "the shared assessment of every internal request"),
        (Auth, "EffectiveDecision", "the combined decision of the effective layers"),
        ("McpExternalContext.cs", "Require", "the inbound check of one external request"),
    ];

    // Sites that are the gate or the plumbing of the calls above, not obligations of their own.
    internal static readonly IReadOnlyList<(string File, string Member, string Reason)> Plumbing =
    [
        (Staging, "AuthorizeCallAsync", "the dispatch gate of every invocation: its staged assessment"),
        (
            Staging,
            "AssessChecksAsync",
            "the gate's assessment of each planned check, as its owner will check it"
        ),
        (Executor, "ExecuteCoreAsync", "dispatch of the invocation's own call"),
        (Auth, "AuthorizeToolAsync", "enforcement of the shared assessment"),
        (Auth, "AuthorizeCreateSessionTargetAsync", "the creation-target probe itself"),
        (
            "Tools/Authorization/ToolAuthorizationEvaluation.cs",
            "EvaluateCreationTarget",
            "the decision-only form of the creation-target evaluation"
        ),
        ("Sessions/SessionManager.NodeFiles.cs", "AuthorizeNodeFileAsync", "Node file wrapper"),
    ];

    // Assessments whose outcome is only reported. They never allow or refuse the call that
    // makes them, so they are not obligations.
    internal static readonly IReadOnlyList<(string File, string Member, string Reason)> ReportOnly =
    [
        (Explain, "ExplainVariantAsync", "explain: each probe as its own caller"),
        (Explain, "ExplainObligationAsync", "explain: each planned obligation of a probe"),
        (Explain, "ExplainCreationTarget", "explain: a probe's timer creation target"),
        (Secrets, "SecretUsableAsync", "list_secrets: the usable field of each stored secret"),
    ];
}
