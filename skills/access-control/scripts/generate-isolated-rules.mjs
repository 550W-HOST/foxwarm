#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const absent = () => ({ exists: false });
const sessionTarget = (scope) => ({ session: scope });

/** Generate a reviewable caller-only fragment, without reading instance state. */
export function generateIsolatedRules(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('Mapping must be a JSON object of Agent names to Node IDs or null.');
  }
  const entries = Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) throw new Error('Mapping must contain at least one Agent.');
  const exactName = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
      || Buffer.byteLength(value, 'utf8') > 512) {
      throw new Error(`${label} must be a non-empty exact name, without surrounding whitespace, up to 512 bytes.`);
    }
  };
  const rules = [];
  entries.forEach(([agent, declaredNode], index) => {
    exactName(agent, 'Agent');
    if (declaredNode !== null) exactName(declaredNode, `Node for ${agent}`);
    const node = declaredNode === 'master' ? null : declaredNode;
    const add = (suffix, match, action = 'allow') => rules.push({
      id: `isolated-basic-${index + 1}-${suffix}`,
      match: { agent, ...match },
      action,
    });
    const builtin = (suffix, name, match = {}) => add(suffix, { tool: { source: 'builtin', name }, ...match });
    const within = (base, arg) => ({ ...(arg ? { arg } : {}), allWithin: base });
    const self = sessionTarget({ self: true });

    if (node) add('node', { tool: { source: 'node' }, targetNode: node });
    add('master-files', {
      tool: { source: 'node', name: ['read', 'write', 'edit', 'apply_patch'] },
      targetNode: 'master', path: within('${agent.dir}'),
    });
    builtin('memory', ['read_memory', 'write_memory', 'edit_memory', 'delete_memory', 'apply_patch_memory'], {
      path: within('${agent.memoryDir}'),
    });

    const nodes = node ? ['master', node] : ['master'];
    for (const [sourceIndex, sourceNode] of nodes.entries()) {
      for (const [targetIndex, targetNode] of nodes.entries()) {
        const masterArgs = [];
        if (sourceNode === 'master') masterArgs.push('sourcePath');
        if (targetNode === 'master') masterArgs.push('targetPath');
        builtin(`copy-${sourceIndex}-${targetIndex}`, 'copy_between_nodes', {
          args: { sourceNode, targetNode },
          ...(masterArgs.length ? { path: within('${agent.dir}', masterArgs) } : {}),
        });
      }
    }
    for (const [nodeIndex, targetNode] of nodes.entries()) {
      const path = targetNode === 'master' ? { path: within('${agent.dir}', 'filePath') } : {};
      builtin(`send-file-${nodeIndex}`, 'send_file', {
        targetNode, args: { sessionId: self, channelTargetId: absent() }, ...path,
      });
      builtin(`save-image-${nodeIndex}`, 'image_write_to_file', { targetNode, ...path });
    }
    builtin('send-relation', 'send_to_session', {
      args: { sessionId: sessionTarget({ relation: ['parent', 'child'] }) },
    });
    builtin('archives', ['get_archived_messages', 'get_archived_blocks'], {
      args: { sessionId: sessionTarget({ sameAgent: true }) },
    });
    builtin('recall-exact', 'recall', {
      args: { vector_query: absent(), sessionId: sessionTarget({ sameAgent: true }) },
    });
    // An omitted vector Session target resolves to self only with
    // scope=current-session. An explicit self target already fixes the scope.
    for (const [variant, agentName] of [['default', absent()], ['own', agent]]) {
      builtin(`recall-vector-${variant}`, 'recall', {
        args: { vector_query: { exists: true }, sessionId: self, agentName },
      });
      builtin(`skill-${variant}`, 'skill', { args: { action: ['list', 'load'], agentName } });
    }
    builtin('status-default', 'session', { args: { action: absent(), sessionId: absent() } });
    builtin('status-explicit', 'session', { args: { action: 'status', sessionId: absent() } });

    builtin('timer-read-delete', ['list_timers', 'delete_timer'], { args: { sessionId: self } });
    for (const [variant, newSession] of [['default', absent()], ['existing', false]]) {
      builtin(`timer-create-${variant}`, 'create_timer', {
        args: { sessionId: self, newSession, agentName: absent(), sessionPrefix: absent() },
      });
    }
    for (const [variant, agentName] of [['default', absent()], ['own', agent]]) {
      builtin(`timer-create-new-${variant}`, 'create_timer', {
        args: { sessionId: self, newSession: true, agentName },
      });
    }
    builtin('timer-update-existing', 'update_timer', {
      args: { sessionId: self, newSession: false, agentName: absent(), sessionPrefix: absent() },
    });
    builtin('timer-update-new', 'update_timer', {
      args: { sessionId: self, newSession: true, agentName: agent },
    });
    builtin('local-tools', ['image_crop', 'wait', 'submit_compact_plan', 'search_tools']);
    add('deny-other', {}, 'deny');
  });
  if (rules.length > 256) {
    throw new Error(`Generated ${rules.length} rules; v1 permits at most 256 in the complete policy. Use a smaller mapping and review the combined candidate's limit.`);
  }
  return { rules };
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node generate-isolated-rules.mjs mapping.json > rules-fragment.yaml\nMapping: {"reviewer":"node-a","writer":null}; null/master means master-only.\nOutputs a rules-only YAML fragment. Review and merge into a complete policy; does not install or change isolation.');
    return;
  }
  if (argv.length !== 1) throw new Error('Expected one mapping.json path. Use --help for usage.');
  const fragment = generateIsolatedRules(JSON.parse(fs.readFileSync(argv[0], 'utf8')));
  process.stdout.write(yaml.dump(fragment, { noRefs: true, lineWidth: 120 }));
  console.error(`Generated ${fragment.rules.length} caller-only rules. Review restrictions and incoming/timer boundaries in references/isolated-rules.md before merging; nothing was installed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Cannot generate rules: ${error.message}`);
    process.exitCode = 1;
  }
}
