const fs = require('fs-extra');
const path = require('path');

const sessionManager = require('../lib/sessionManager');
const { MessageRouter } = require('../lib/messageRouter');
const { getAgentDir, STATE_DIR } = require('../lib/config');

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCtx(channelId, conversationId, replies, username = 'toolscript-skill-trial-user') {
  return {
    channelId,
    platform: 'webui',
    reply: async (text) => {
      replies.push(String(text));
    },
    sendTyping: async () => {},
    username,
    channelUserId: conversationId,
    conversationId,
    preferDirectReply: true,
  };
}

function extractFunctionCallNames(session) {
  const names = [];
  for (const message of session.history || []) {
    for (const part of message.parts || []) {
      if (part.functionCall?.name) {
        names.push(String(part.functionCall.name));
      }
    }
  }
  return names;
}

function extractFunctionCalls(session) {
  const calls = [];
  for (const message of session.history || []) {
    for (const part of message.parts || []) {
      if (part.functionCall?.name) {
        calls.push({
          name: String(part.functionCall.name),
          args: part.functionCall.args || null,
          rawArgsText: part.functionCall.rawArgsText || '',
        });
      }
    }
  }
  return calls;
}

async function listRunRecords() {
  const dir = path.join(STATE_DIR, 'toolscript-runs');
  try {
    const names = await fs.readdir(dir);
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        records.push(await fs.readJson(path.join(dir, name)));
      } catch {}
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    return [];
  }
}

async function findLatestRunForSession(sessionId) {
  const records = await listRunRecords();
  return records.find(record => record.ownerSessionId === sessionId);
}

async function waitFor(fn, timeoutMs = 20000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function runPrompt(router, sessionId, conversationId, prompt, username) {
  const replies = [];
  await router.handleMessage(
    makeCtx('webui', conversationId, replies, username),
    {
      parts: [{ text: prompt }],
      channelUserId: conversationId,
      conversationId,
      username,
    },
  );
  const session = await sessionManager.getSession(sessionId);
  return { replies, session };
}

async function main() {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));

  const automationSessionId = makeId('toolscript_skill_auto_session');
  const automationConversationId = makeId('toolscript_skill_auto_conv');
  const automationScriptName = 'toolscript_skill_trial_automation.py';
  const automationScriptPath = path.join(getAgentDir('main'), automationScriptName);

  const controllerSessionId = makeId('toolscript_skill_controller_session');
  const controllerConversationId = makeId('toolscript_skill_controller_conv');
  const controllerScriptName = 'toolscript_skill_trial_controller.py';
  const controllerScriptPath = path.join(getAgentDir('main'), controllerScriptName);
  const targetSessionId = makeId('toolscript_skill_target_session');
  const targetConversationId = makeId('toolscript_skill_target_conv');

  try {
    await sessionManager.createEmptySession(automationSessionId);
    await sessionManager.createEmptySession(controllerSessionId);
    await sessionManager.createEmptySession(targetSessionId);
    sessionManager.attachChannel('webui', automationConversationId, automationSessionId);
    sessionManager.attachChannel('webui', controllerConversationId, controllerSessionId);
    sessionManager.attachChannel('webui', targetConversationId, targetSessionId);

    const automationPrompt = [
      'You have new ToolScript skills available.',
      'Before guessing APIs, inspect the relevant ToolScript skill docs with load_skill, then read the canonical example path mentioned in that skill.',
      `Then create a ToolScript file named \`${automationScriptName}\` in the current agent folder.`,
      'Prefer using any helper mentioned in the skill/example if it fits. Avoid repo-wide grep unless the skill/example is still insufficient.',
      'The script should search builtin tools for "read file", print the top tool name, read `skills/toolscript_automation/SKILL.md`, print a short excerpt, ask_agent("Reply with a short label"), and return a dict with the label and tool count.',
      'After writing the file, run it with run_script, continue it with input `TRIAL_OK`, and then briefly report whether it worked.',
      'Keep the final reply concise.',
    ].join(' ');

    const automationResult = await runPrompt(router, automationSessionId, automationConversationId, automationPrompt, 'toolscript-skill-auto-user');
    const automationSession = automationResult.session;
    const automationRun = await findLatestRunForSession(automationSessionId);
    const automationScriptExists = await fs.pathExists(automationScriptPath);
    const automationScriptContent = automationScriptExists ? await fs.readFile(automationScriptPath, 'utf8') : '';

    const controllerPrompt = [
      `A target session already exists with session id \`${targetSessionId}\`.`,
      'Before guessing APIs, inspect the relevant ToolScript managed-controller skill docs with load_skill, then read the canonical example path mentioned in that skill.',
      `Then create a ToolScript file named \`${controllerScriptName}\` in the current agent folder.`,
      'Prefer using any helper mentioned in the skill/example if it fits. Avoid repo-wide grep unless the skill/example is still insufficient.',
      'The controller should open managed control of the target session, wait for one managed event, handle it with a short manager message like "Controller handled this request.", then release the session.',
      'Start it as a background ToolScript run and briefly report the background run id plus whether it is waiting for managed_event.',
      'Keep the final reply concise.',
    ].join(' ');

    const controllerResult = await runPrompt(router, controllerSessionId, controllerConversationId, controllerPrompt, 'toolscript-skill-controller-user');
    const controllerSession = controllerResult.session;
    let controllerRun = await waitFor(async () => {
      const record = await findLatestRunForSession(controllerSessionId);
      return record || null;
    }, 15000, 250);

    const targetReplies = [];
    await router.handleMessage(
      makeCtx('webui', targetConversationId, targetReplies, 'toolscript-skill-target-user'),
      {
        parts: [{ text: 'Please help me handle this queued request.' }],
        channelUserId: targetConversationId,
        conversationId: targetConversationId,
        username: 'toolscript-skill-target-user',
      },
    );

    controllerRun = await waitFor(async () => {
      const record = await findLatestRunForSession(controllerSessionId);
      if (record && (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled')) {
        return record;
      }
      return null;
    }, 20000, 250) || controllerRun;

    const controllerScriptExists = await fs.pathExists(controllerScriptPath);
    const controllerScriptContent = controllerScriptExists ? await fs.readFile(controllerScriptPath, 'utf8') : '';
    const targetSession = await sessionManager.getSession(targetSessionId);

    console.log(JSON.stringify({
      env: {
        container: 'foxwarm-toolscript-managed-session-test',
        url: 'http://localhost:3004',
      },
      automationScenario: {
        sessionId: automationSessionId,
        replies: automationResult.replies,
        functionCalls: extractFunctionCallNames(automationSession),
        functionCallDetails: extractFunctionCalls(automationSession),
        usedLoadSkill: extractFunctionCallNames(automationSession).includes('load_skill'),
        usedExampleRead: extractFunctionCalls(automationSession).some(call => call.name === 'read' && /examples\/toolscript\/automation_basic\.py/.test(call.rawArgsText || '')),
        usedExec: extractFunctionCallNames(automationSession).includes('exec'),
        scriptExists: automationScriptExists,
        scriptPreview: automationScriptContent.slice(0, 1200),
        latestRun: automationRun ? {
          runId: automationRun.runId,
          status: automationRun.status,
          mode: automationRun.mode,
          waiting: automationRun.waiting,
          stdout: automationRun.stdout,
          executedTools: automationRun.executedTools,
          lastResult: automationRun.lastResult,
          error: automationRun.error,
        } : null,
      },
      controllerScenario: {
        sessionId: controllerSessionId,
        targetSessionId,
        replies: controllerResult.replies,
        functionCalls: extractFunctionCallNames(controllerSession),
        functionCallDetails: extractFunctionCalls(controllerSession),
        usedLoadSkill: extractFunctionCallNames(controllerSession).includes('load_skill'),
        usedExampleRead: extractFunctionCalls(controllerSession).some(call => call.name === 'read' && /examples\/toolscript\/managed_controller_basic\.py/.test(call.rawArgsText || '')),
        usedExec: extractFunctionCallNames(controllerSession).includes('exec'),
        scriptExists: controllerScriptExists,
        scriptPreview: controllerScriptContent.slice(0, 1600),
        latestRun: controllerRun ? {
          runId: controllerRun.runId,
          status: controllerRun.status,
          mode: controllerRun.mode,
          waiting: controllerRun.waiting,
          relatedManagedSessions: controllerRun.relatedManagedSessions,
          stdout: controllerRun.stdout,
          executedTools: controllerRun.executedTools,
          lastResult: controllerRun.lastResult,
          error: controllerRun.error,
        } : null,
        directUserReplyWhileManaged: targetReplies,
        targetHistoryTail: (targetSession.history || []).slice(-4),
      },
    }, null, 2));
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    sessionManager.detachChannel('webui', automationConversationId);
    sessionManager.detachChannel('webui', controllerConversationId);
    sessionManager.detachChannel('webui', targetConversationId);
    await sessionManager.deleteSession(automationSessionId).catch(() => false);
    await sessionManager.deleteSession(controllerSessionId).catch(() => false);
    await sessionManager.deleteSession(targetSessionId).catch(() => false);
    await fs.remove(automationScriptPath).catch(() => false);
    await fs.remove(controllerScriptPath).catch(() => false);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});