import type { HttpServer } from '../httpServer';
import { TaskError, type TaskService } from '../taskService';

/** Authenticated task views and explicit Session-targeted management operations. */
export function registerWebUiTaskRoutes(server: HttpServer, service: TaskService): void {
  const failure = (res: any, error: unknown): void => {
    if (error instanceof TaskError) res.status(error.statusCode).json({ code: error.code, error: error.message });
    else res.status(500).json({ code: 'TASK_READ_FAILED', error: 'Tasks could not be loaded.' });
  };
  server.addRoute({ path: '/api/tasks', method: 'GET', handler: async (req, res) => {
    try {
      if (Object.keys(req.query).some(key => !['status', 'limit'].includes(key))
        || (req.query.status !== undefined && typeof req.query.status !== 'string')
        || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9]\d*$/.test(req.query.limit)))) {
        throw new TaskError('TASK_INVALID_ARGS', 'Invalid task query.');
      }
      res.json(service.list(req.query.status as string | undefined,
        req.query.limit === undefined ? undefined : Number(req.query.limit), true));
    } catch (error) { failure(res, error); }
  } });
  server.addRoute({ path: '/api/tasks/:id', method: 'GET', handler: async (req, res) => {
    try {
      if (Object.keys(req.query).length) throw new TaskError('TASK_INVALID_ARGS', 'Task details do not accept query parameters.');
      res.json(service.get(String(req.params.id)));
    } catch (error) { failure(res, error); }
  } });
  const writes = [
    { path: '/api/tasks', method: 'POST' as const, action: 'create' },
    { path: '/api/tasks/:id/claim', method: 'POST' as const, action: 'claim' },
    { path: '/api/tasks/:id/assign', method: 'POST' as const, action: 'assign' },
    { path: '/api/tasks/:id', method: 'PATCH' as const, action: 'update' },
    { path: '/api/tasks/:id/complete', method: 'POST' as const, action: 'complete' },
    { path: '/api/tasks/:id/cancel', method: 'POST' as const, action: 'cancel' },
  ];
  for (const route of writes) server.addRoute({ ...route, handler: async (req, res) => {
    try {
      if (Object.keys(req.query).length || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new TaskError('TASK_INVALID_ARGS', 'Task operations require a JSON object body.');
      }
      const { sessionId, ...fields } = req.body;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256)) {
        throw new TaskError('TASK_INVALID_ARGS', 'sessionId must identify an existing Session.');
      }
      if ('action' in fields || 'taskId' in fields) throw new TaskError('TASK_INVALID_ARGS', 'The route selects the task and action.');
      const args = { ...fields, action: route.action, ...(req.params.id ? { taskId: String(req.params.id) } : {}) };
      const result = await service.executeForWebUi(args, sessionId);
      res.status(route.action === 'create' ? 201 : 200).json(result);
    } catch (error) { failure(res, error); }
  } });

}
