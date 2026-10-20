/** Source IPC transport for the shared data-only compiler. */
import path from 'node:path';
import { compileReact } from '../../packages/shared/dist/artifacts/reactCompiler';
const runtimeRoot = path.resolve(__dirname, '../../packages/webui/node_modules');
process.once('message', async (input: unknown) => {
  try {
    const compiled = await compileReact(input, runtimeRoot);
    process.send?.({ compiled }, () => process.exit(0));
  } catch (err: any) { process.send?.({ error: String(err.errors?.[0]?.text || err.message || err).slice(0, 1500) }, () => process.exit(1)); }
});
