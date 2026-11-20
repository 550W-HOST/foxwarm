// Line-delimited JSON protocol over a byte stream pair (the host's stdin/stdout).
//   request  {"id": 1, "tool": "browser_click", "args": {...}, "deadlineMs": 60000}
//   cancel   {"cancel": 1}
//   response {"id": 1, "ok": true, "result": {...}} | {"id": 1, "ok": false, "error": "..."}
// Closing the input ends the host: nothing outlives the process that started it.
import readline from 'node:readline';

export const DEFAULT_DEADLINE_MS = 120000;
export const MAX_DEADLINE_MS = 600000;

export function serve({ input, output, manager, onExit = () => {} }) {
  const calls = new Map();
  const send = (message) => output.write(JSON.stringify(message) + '\n');

  async function run(message) {
    const controller = new AbortController();
    const requested = Number.isFinite(message.deadlineMs) ? message.deadlineMs : DEFAULT_DEADLINE_MS;
    const budget = Math.min(Math.max(requested, 1), MAX_DEADLINE_MS);
    const deadline = Date.now() + budget;
    const timer = setTimeout(
      () => controller.abort(new Error('Browser call deadline expired.')),
      budget,
    );
    calls.set(message.id, controller);
    try {
      const result = await manager.execute(message.tool, message.args ?? {}, {
        signal: controller.signal,
        deadline,
      });
      send({ id: message.id, ok: true, result });
    } catch (error) {
      send({ id: message.id, ok: false, error: String(error?.message || error) });
    } finally {
      clearTimeout(timer);
      calls.delete(message.id);
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.cancel !== undefined) {
      calls.get(message.cancel)?.abort(new Error('Browser call canceled.'));
      return;
    }
    if (!message || !Number.isInteger(message.id) || typeof message.tool !== 'string') return;
    void run(message);
  });
  lines.on('close', async () => {
    for (const controller of calls.values()) controller.abort(new Error('Browser host closed.'));
    await manager.close();
    onExit();
  });
  return lines;
}
