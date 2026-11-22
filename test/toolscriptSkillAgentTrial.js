require('../scripts/test/test-process-env.cjs').initializeTestEnvironment();
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

  try {
    await sessionManager.createEmptySession(automationSessionId);
    sessionManager.attachChannel('webui', automationConversationId, automationSessionId);

    const automationPrompt = [
      'You have a ToolScript skill available.',
      'Before guessing APIs, inspect the relevant ToolScript skill docs with skill(action="load"), then read the canonical example path mentioned in that skill.',
      `Then create a ToolScript file named \`${automationScriptName}\` in the current agent folder.`,
      'Prefer using any helper mentioned in the skill/example if it fits. Avoid repo-wide grep unless the skill/example is still insufficient.',
      'The script should use a small known tool flow: list files under `skills/toolscript-automation/examples`, print the count, read `skills/toolscript-automation/SKILL.md`, print a short excerpt, ask_agent("Reply with a short label"), and return a dict with the label and file count.',
      'After writing the file, run it with run_script, continue it with input `TRIAL_OK`, and then briefly report whether it worked.',
      'Keep the final reply concise.',
    ].join(' ');

    const automationResult = await runPrompt(router, automationSessionId, automationConversationId, automationPrompt, 'toolscript-skill-auto-user');
    const automationSession = automationResult.session;
    const automationRun = await findLatestRunForSession(automationSessionId);
    const automationScriptExists = await fs.pathExists(automationScriptPath);
    const automationScriptContent = automationScriptExists ? await fs.readFile(automationScriptPath, 'utf8') : '';

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
        usedLoadSkill: extractFunctionCalls(automationSession).some(call => call.name === 'skill' && call.rawArgsText.includes('load')),
        usedExampleRead: extractFunctionCalls(automationSession).some(call => call.name === 'read' && /toolscript-automation\/examples\/automation_basic\.py/.test(call.rawArgsText || '')),
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
    }, null, 2));
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    sessionManager.detachChannel('webui', automationConversationId);
    await sessionManager.deleteSession(automationSessionId).catch(() => false);
    await fs.remove(automationScriptPath).catch(() => false);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});