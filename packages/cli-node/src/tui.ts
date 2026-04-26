#!/usr/bin/env node
process.env.FOXWARM_NO_CONSOLE_LOG = '1';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { NodeClient, CliNodeHistoryMessage, CliNodeSessionSummary } from './client';

type Opts = {
  host: string;
  nodeId?: string;
  token?: string;
  authToken?: string;
  credentialsFile?: string;
  localTrigger?: boolean;
  localTriggerPort?: number;
  autoApproveAll?: boolean;
  autoApprove?: string;
  timeout?: number;
};

type Approval = {
  tool: string;
  args: any;
  sessionId: string;
  resolve: (value: boolean | string) => void;
  timeout?: NodeJS.Timeout;
};

type StatusLine = { event: string; detail?: Record<string, any>; at: number };

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const o: any = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host') o.host = args[++i];
    else if (a === '--id') o.nodeId = args[++i];
    else if (a === '--token') o.token = args[++i];
    else if (a === '--auth-token') o.authToken = args[++i];
    else if (a === '--credentials-file') o.credentialsFile = args[++i];
    else if (a === '--local-trigger-port') o.localTriggerPort = Number(args[++i]);
    else if (a === '--no-local-trigger') o.localTrigger = false;
    else if (a === '--auto-approve') o.autoApprove = args[++i];
    else if (a === '--auto-approve-all') o.autoApproveAll = true;
    else if (a === '--timeout') o.timeout = Number(args[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Foxwarm cli-node\n\nUsage:\n  cli-node --host URL --id NAME --token TOKEN [options]\n\nOptions:\n  --host <url>              Master URL (required)\n  --id <name>               Node name/requested name\n  --token <token>           Pairing token\n  --auth-token <token>      Approved node auth token (requires --id)\n  --credentials-file <path> Stored credentials file\n  --auto-approve <regex>    Auto-approve matching tool calls\n  --auto-approve-all        Skip all tool confirmations\n  --timeout <seconds>       Auto-reject pending tool calls after N seconds\n  --no-local-trigger        Disable local trigger endpoint\n\nKeys:\n  Up/Down: select bound session   Enter: send input   Ctrl+R: refresh   Ctrl+C/Q: quit\n  When a tool call is pending: Y approve, N reject, A toggle auto-approve-all`);
      process.exit(0);
    }
  }
  if (!o.host) {
    console.error('Error: --host required. Use --help.');
    process.exit(1);
  }
  if (!o.token && !(o.authToken && o.nodeId) && !o.credentialsFile) {
    console.error('Error: provide --token, --auth-token+--id, or --credentials-file');
    process.exit(1);
  }
  return o as Opts;
}

function messageText(message: CliNodeHistoryMessage): string {
  const text = message.text || '';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function toolPreview(tool: string, args: any): string {
  const json = (() => {
    try { return JSON.stringify(args); } catch { return String(args); }
  })();
  return `${tool} ${json.length > 260 ? `${json.slice(0, 260)}…` : json}`;
}

function App({ opts }: { opts: Opts }) {
  const { exit } = useApp();
  const [status, setStatus] = useState<StatusLine>({ event: 'starting', at: Date.now() });
  const [sessions, setSessions] = useState<CliNodeSessionSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<CliNodeHistoryMessage[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [autoApproveAll, setAutoApproveAll] = useState(!!opts.autoApproveAll);
  const [approval, setApproval] = useState<Approval | null>(null);
  const clientRef = useRef<NodeClient | null>(null);
  const autoApprovePattern = useMemo(() => opts.autoApprove ? new RegExp(opts.autoApprove, 'i') : null, [opts.autoApprove]);
  const selectedSession = sessions[selected];

  const refresh = async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const nextSessions = await client.listBoundSessions();
      setSessions(nextSessions);
      const nextSelected = Math.max(0, Math.min(selected, nextSessions.length - 1));
      setSelected(nextSelected);
      const session = nextSessions[nextSelected];
      if (session) {
        const result = await client.getSessionHistory(session.id, 30);
        setHistory(result.messages || []);
        setTotalMessages(result.totalMessages || 0);
      } else {
        setHistory([]);
        setTotalMessages(0);
      }
      setNotice(`Refreshed ${new Date().toLocaleTimeString()}`);
    } catch (err: any) {
      setNotice(`Refresh failed: ${err?.message || String(err)}`);
    }
  };

  useEffect(() => {
    const client = new NodeClient({
      host: opts.host,
      nodeId: opts.nodeId,
      token: opts.token,
      authToken: opts.authToken,
      credentialsFile: opts.credentialsFile,
      localTrigger: opts.localTrigger,
      localTriggerPort: opts.localTriggerPort,
      toolCallInterceptor: async (tool, args, sessionId, _callId, serverTimeoutMs) => {
        if (autoApproveAll || (autoApprovePattern && autoApprovePattern.test(tool))) return true;
        return await new Promise<boolean | string>((resolve) => {
          const effectiveTimeoutMs = serverTimeoutMs || (opts.timeout ? opts.timeout * 1000 : 0);
          const timeout = effectiveTimeoutMs > 0 ? setTimeout(() => {
            setApproval(null);
            resolve('timeout');
          }, Math.max(1000, effectiveTimeoutMs - 2000)) : undefined;
          setApproval({ tool, args, sessionId, resolve, timeout });
        });
      },
      onStatus: (event, detail) => {
        setStatus({ event, detail, at: Date.now() });
        if (event === 'registered' || event === 'pair_approved') setTimeout(() => void refresh(), 300);
      },
    });
    clientRef.current = client;
    client.startLocalTriggerServer()
      .then(() => client.connect())
      .then(() => setTimeout(() => void refresh(), 1000))
      .catch((err) => setNotice(`Startup failed: ${err?.message || String(err)}`));
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      approval?.resolve('timeout');
      void client.disconnect();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => { void refresh(); }, [selected]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (input === 'q' && draft.length === 0 && !approval) { exit(); return; }
    if (approval) {
      if (input === 'a' || input === 'A') { setAutoApproveAll(v => !v); return; }
      if (input === 'y' || input === 'Y' || key.return) {
        if (approval.timeout) clearTimeout(approval.timeout);
        approval.resolve(true);
        setApproval(null);
        setNotice('Tool approved');
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        if (approval.timeout) clearTimeout(approval.timeout);
        approval.resolve(false);
        setApproval(null);
        setNotice('Tool rejected');
        return;
      }
      return;
    }
    if (key.ctrl && input === 'r') { void refresh(); return; }
    if (key.upArrow) { setSelected(v => Math.max(0, v - 1)); return; }
    if (key.downArrow) { setSelected(v => Math.min(sessions.length - 1, v + 1)); return; }
    if (key.backspace || key.delete) { setDraft(v => v.slice(0, -1)); return; }
    if (key.return) {
      const msg = draft.trim();
      if (msg && selectedSession && clientRef.current) {
        setDraft('');
        clientRef.current.sendSessionMessage(selectedSession.id, msg)
          .then(() => { setNotice(`Sent to ${selectedSession.id}`); setTimeout(() => void refresh(), 500); })
          .catch((err: any) => setNotice(`Send failed: ${err?.message || String(err)}`));
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) setDraft(v => v + input);
  });

  const statusText = `${status.event}${status.detail?.nodeId ? ` ${status.detail.nodeId}` : ''}${status.detail?.pairCode ? ` code:${status.detail.pairCode}` : ''}`;

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Box, null,
      React.createElement(Text, { color: 'cyan', bold: true }, 'foxwarm cli-node '),
      React.createElement(Text, { color: status.event === 'disconnected' ? 'red' : 'green' }, statusText),
      React.createElement(Text, { color: 'gray' }, `  host:${opts.host} auto:${autoApproveAll ? 'all' : (opts.autoApprove ? `/${opts.autoApprove}/` : 'manual')}`)
    ),
    React.createElement(Box, { borderStyle: 'single', paddingX: 1, flexDirection: 'column' },
      React.createElement(Text, { bold: true }, `Bound sessions (${sessions.length})`),
      ...(sessions.length ? sessions.slice(0, 8).map((s, i) => React.createElement(Text, { key: s.id, color: i === selected ? 'yellow' : undefined }, `${i === selected ? '›' : ' '} ${s.id}${s.displayName ? ` — ${s.displayName}` : ''} (${s.messageCount})${s.busy ? ' busy' : ''}`)) : [React.createElement(Text, { key: 'none', color: 'gray' }, 'No sessions bound to this node yet')])
    ),
    React.createElement(Box, { borderStyle: 'round', paddingX: 1, flexDirection: 'column' },
      React.createElement(Text, { bold: true }, selectedSession ? `History: ${selectedSession.id} (${history.length}/${totalMessages})` : 'History'),
      ...(history.length ? history.slice(-12).map(m => React.createElement(Text, { key: m.index }, `${m.index}. ${m.role}: ${messageText(m).replace(/\n/g, ' ')}`)) : [React.createElement(Text, { key: 'empty', color: 'gray' }, 'Select a session or wait for refresh')])
    ),
    approval ? React.createElement(Box, { borderStyle: 'double', paddingX: 1, flexDirection: 'column' },
      React.createElement(Text, { color: 'yellow', bold: true }, `Tool call pending for ${approval.sessionId}`),
      React.createElement(Text, null, toolPreview(approval.tool, approval.args)),
      React.createElement(Text, null, 'Y/Enter approve, N/Esc reject, A toggle auto-approve')
    ) : null,
    React.createElement(Box, null,
      React.createElement(Text, { color: selectedSession ? 'green' : 'gray' }, selectedSession ? `Send to ${selectedSession.id}: ` : 'No session: '),
      React.createElement(Text, null, draft || '')
    ),
    React.createElement(Text, { color: notice.startsWith('Send failed') || notice.startsWith('Refresh failed') || notice.startsWith('Startup failed') ? 'red' : 'gray' }, notice || 'Up/Down select • Enter send • Ctrl+R refresh • Ctrl+C/Q quit')
  );
}

render(React.createElement(App, { opts: parseArgs() }));
