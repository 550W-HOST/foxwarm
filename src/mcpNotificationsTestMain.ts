// Independent Main service composition for the two-instance loopback test.
// Real Session owners, durable ingress, MCP services and HTTP transports run in
// each process; the existing Worker fixture supplies deterministic local turns.
import path from 'node:path';
import { HttpServer } from './httpServer';
import { normalizeAccessConfig } from './accessConfig';
import { McpInboundHttpService } from './mcpInboundHttp';
import { McpInboundMcpCatalog } from './mcpInboundCatalog';
import * as sessions from './sessionManager';
import * as runtime from './sessionRuntime';
import * as mcp from './mcpExternalService';
import { initializeMainManagementTools, executeMainManagementTool, shutdownMainManagementTools } from './mainManagementTools';
import { tool_call_tool } from './tools/unifiedSearch';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { installAgentMetadataSnapshotForWorker } from './session/agentMetadata';
import { STATE_DIR } from './config';

async function start() {
  await sessions.loadSessions();
  const worker = process.env.FOXWARM_TEST_NOTIFICATION_WORKERS === '1';
  const workerEnv: Record<string, string> = { FOXWARM_DATA_DIR: process.env.FOXWARM_DATA_DIR! };
  let store: SessionWorkerStore | undefined;
  let supervisor: SessionWorkerSupervisor | undefined;
  let ingress: SessionWorkerIngressCoordinator | undefined;
  if (worker) {
    store = new SessionWorkerStore(path.join(STATE_DIR, 'notification-mailbox.sqlite'));
    store.open();
    supervisor = new SessionWorkerSupervisor({ store, idleMs: 60_000,
      workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'), workerEnv,
      getCatalogStub: id => sessions.getSessionCatalog(id),
      getAgentMetadataSnapshot: id => sessions.getAgentMetadata(sessions.getSessionCatalog(id)?.agent || 'main'),
      readSessionHistory: id => runtime.getHistory(id),
      presentationSink: {
        broadcastMessage: () => {}, notifySessionEvent: () => {},
        broadcastQueueHistoryAppend: () => {},
      },
    });
    await supervisor.reconcileStartupOwnerships();
    ingress = new SessionWorkerIngressCoordinator(store, supervisor,
      id => sessions.resolveLoadedSessionId(id), id => !!sessions.getSessionCatalog(id),
      (id, operation, admit) => sessions.withSessionDestructiveMutationAdmission([id], operation, admit));
    sessions.setSessionWorkerEnqueueSink((id, item, options, guard) => ingress!.enqueueEnsuringWorker(id, item, options, guard).then(() => { process.send?.({ event: 'input', sessionId: id }); }));
  } else {
    sessions.setSessionTriggerCallback(sessionId => { process.send?.({ event: 'input', sessionId }); });
  }
  await runtime.initializeSessionRuntime(worker ? { worker: { store: store!, supervisor: supervisor!, registry: supervisor!.projectionRegistry, ingress: ingress! } } : undefined);
  await initializeMainManagementTools({ workerStore: store, readSessionHistory: id => runtime.getHistory(id) });
  await mcp.initializeMcpExternalService();
  const http = new HttpServer(0, 'synthetic-instance-token');
  let releaseGet: (() => void) | undefined;
  let getGate: Promise<void> | undefined;
  http.app.use('/mcp', async (req, _res, next) => {
    if (req.method === 'GET' && getGate) {
      process.send?.({ event: 'get-blocked' });
      await getGate;
    }
    next();
  });
  let effects = 0;
  const catalog = new McpInboundMcpCatalog();
  const listTools = catalog.listTools.bind(catalog);
  const callTool = catalog.callTool.bind(catalog);
  const contextExecs = new Map<string, string[]>();
  catalog.listTools = async (context, principal) => [...await listTools(context, principal), {
    name: 'fixture_context', description: 'Synthetic context fixture.', inputSchema: { type: 'object' },
  }];
  catalog.callTool = async (context, name, args, signal, principal) => {
    if (name !== 'fixture_context') return callTool(context, name, args, signal, principal);
    if (typeof args.nodeId === 'string') context.currentNode = args.nodeId;
    if (typeof args.cwd === 'string') context.cwd = args.cwd;
    if (typeof args.execId === 'string') contextExecs.set(context.id, [...contextExecs.get(context.id) || [], args.execId]);
    if (args.effect) effects++;
    const value = { contextId: context.id, currentNode: context.currentNode, cwd: context.cwd, execIds: contextExecs.get(context.id) || [] };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(args.fail ? { isError: true } : {}) };
  };
  const inbound = new McpInboundHttpService(normalizeAccessConfig({ identities: {
    peer: { token: 'synthetic-peer-token', surfaces: { mcp: {} } },
  } }), catalog);
  inbound.register(http);
  await http.start();
  const port = ((http as any).httpServer.address() as { port: number }).port;
  process.send?.({ event: 'ready', port });
  process.on('message', async (command: any) => {
    if (!command?.id) return;
    try {
      let result: unknown;
      const ctx = { sessionId: command.sessionId };
      switch (command.action) {
        case 'holdGet':
          getGate = new Promise<void>(resolve => { releaseGet = resolve; });
          result = true;
          break;
        case 'releaseGet':
          releaseGet?.(); getGate = undefined;
          result = true;
          break;
        case 'effects': result = effects; break;
        case 'contexts':
          result = [...(inbound as any).connections.values()].map((connection: any) => ({ id: connection.id, currentNode: connection.context.currentNode, cwd: connection.context.cwd }));
          break;
        case 'dropContexts':
          await Promise.all([...(inbound as any).connections.values()].map(connection => (inbound as any).dispose(connection)));
          result = true;
          break;
        case 'discover':
          result = await mcp.listMcpTools(command.sessionId, 'peer');
          break;
        case 'notify': {
          const id = String(command.target).slice(4).split(':')[0];
          const connection = (inbound as any).connections.get(id);
          await connection.server.notification({ method: command.method, params: command.params });
          result = true;
          break;
        }
        case 'create': {
          const { session } = await sessions.createEmptySession(command.sessionId);
          session.persistentMemorySnapshot = 'synthetic notification test prompt';
          await sessions.saveSession(session.id);
          result = session.id;
          break;
        }
        case 'policy':
          setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(command.policy));
          result = true;
          break;
        case 'config':
          await mcp.configureMcpServer({ sourceSessionId: command.sessionId, name: 'peer', action: 'upsert', config: command.config });
          result = true;
          break;
        case 'notifications':
          result = await tool_call_tool({ toolId: 'builtin:mcp_notifications', args: { server: 'peer', action: command.operation } }, ctx);
          break;
        case 'call':
          result = await tool_call_tool({ toolId: `mcp:peer/${command.tool || 'foxwarm_session'}`, args: command.args }, ctx);
          break;
        case 'send':
          result = await executeMainManagementTool('send_to_channel', { channelTargetId: command.target, message: command.message }, ctx);
          break;
        case 'workerReply':
          if (!supervisor || !ingress) throw new Error('Worker fixture required');
          await supervisor.stopWorker(command.sessionId);
          workerEnv.FOXWARM_TEST_MAIN_TOOLS_SESSION = command.sessionId;
          workerEnv.FOXWARM_TEST_MAIN_TOOLS = JSON.stringify([{ name: 'send_to_channel', args: { channelTargetId: command.target, message: command.message } }]);
          result = await ingress.submitEnsuringWorker(command.sessionId, { type: 'user', parts: [{ text: 'Perform the explicit reply tool call in this deterministic fixture.' }] });
          break;
        case 'isolated': {
          const source = sessions.getSessionCatalog(command.sessionId)!;
          source.agent = 'notification-isolated';
          installAgentMetadataSnapshotForWorker(source.agent, { isolated: true });
          result = true;
          break;
        }
        case 'history': {
          const history = await runtime.getHistory(command.sessionId);
          result = { messages: history?.messages, queue: history?.queue, mainHistory: sessions.getSessionCatalog(command.sessionId)?.history, worker: supervisor?.getStatus(command.sessionId) };
          break;
        }
        case 'delete': result = await sessions.deleteSession(command.sessionId); break;
        case 'fenceReceivers':
          await mcp.shutdownMcpNotificationReceivers();
          result = true;
          break;
        case 'stop':
          await inbound.stop();
          await mcp.shutdownMcpExternalService();
          await shutdownMainManagementTools();
          await runtime.shutdownSessionRuntime();
          await supervisor?.shutdown();
          store?.close();
          await http.stop();
          process.send?.({ id: command.id, result: true });
          process.disconnect?.();
          return;
        default: throw new Error('Unknown fixture command');
      }
      process.send?.({ id: command.id, result });
    } catch (error) { process.send?.({ id: command.id, error: String((error as Error).message) }); }
  });
}
start().catch(error => { console.error(error); process.exitCode = 1; });
