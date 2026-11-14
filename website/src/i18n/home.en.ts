import type { HomeStrings } from './home';

const docs = (page = '') => `/docs/${page}`;

export const en: HomeStrings = {
  htmlLang: 'en',
  path: '/',
  meta: {
    title: 'Foxwarm — self-hosted AI agents that keep working',
    description: 'Foxwarm is an open-source, self-hosted workspace for long-running AI agents: one server holds the agent loop, models and memory, while lightweight Nodes run tools on any machine. Delegate to sessions you can open, and bring any session into a group chat.',
    ogTitle: 'Foxwarm — self-hosted AI agents that keep working'
  },
  nav: { features: 'Features', install: 'Install', docs: 'Docs', github: 'GitHub', theme: 'Switch color theme', language: '中文', languageLabel: '切换到中文', skip: 'Skip to content' },
  hero: {
    title: 'It keeps working after you close the laptop.',
    lede: 'Foxwarm runs your AI agents on a server you own. One task can run for days, spread across your machines, and report back wherever you are: in the browser, on your phone or in your team’s group chat.',
    timeline: {
      label: 'One Tuesday, one task',
      rows: [
        { time: '09:10', place: 'laptop', icon: 'laptop', text: 'You ask:', quote: 'CI on main is red. Find out why and fix it.' },
        { time: '09:12', place: 'build-box', icon: 'server', text: 'It hands the test run to a child session, which runs the suite on your build server.' },
        { time: '09:30', icon: 'moon', text: 'You close the laptop and go to a meeting. The work carries on.', highlight: true },
        { time: '12:40', place: 'phone', icon: 'phone', text: 'You open the child session on your phone and steer it:', quote: 'Keep full precision in prorate().' },
        { time: '18:30', place: 'team chat', icon: 'chat', text: 'It posts a two-line summary in your team’s group. A colleague asks a follow-up; it answers from the full history.' }
      ],
      footer: 'Every step is a session you can open, read and talk to.',
      link: 'How Foxwarm works'
    },
    shotCaption: 'The same task in the Foxwarm WebUI. Real screenshot, demo project.',
    screenshotAlt: 'The Foxwarm WebUI in Conversation view: the user asks an agent to fix a failing test suite, and the agent reports the cause, the fix and the commit. The sidebar lists other sessions, some with child sessions.'
  },
  install: {
    tabs: { linux: 'Linux / macOS', windows: 'Windows', docker: 'Docker' },
    copy: 'Copy',
    copied: 'Copied',
    notes: {
      linux: 'Linux x64 (including WSL) and macOS arm64. Downloads a prebuilt release and starts it in the background, using tmux when available. Needs no .NET. A macOS desktop app is also available.',
      windows: 'Windows x64, in PowerShell. Downloads a prebuilt release and runs it in the background. A Windows desktop app is also available.',
      docker: 'Linux x64 with Docker. Runs the published image with Chromium and Node.js included; data stays in foxwarm-data.'
    },
    requirementsLink: 'Packages and requirements'
  },
  strip: {
    label: 'Works with',
    items: ['OpenAI-compatible APIs', 'Anthropic', 'Local gateways', 'MCP', 'Telegram', 'Matrix', 'QQ', 'WeChat', 'WeCom']
  },
  features: [
    {
      id: 'memory',
      eyebrow: 'Long-running sessions',
      title: 'Long conversations stay sharp.',
      body: 'When a session nears the model’s context limit, Foxwarm compacts older turns into layered summaries instead of dropping them. The original messages stay in the archive, and the agent can pull back the exact text when a detail matters again. Sessions also survive restarts.',
      points: ['Layered summaries that point back to their sources', 'Exact recall of archived messages', 'Optional semantic search across past sessions'],
      link: { label: 'How compaction and recall work', href: docs('history-search/') },
      image: { alt: 'A Foxwarm session after compaction. Asked for the exact original output behind a support ticket, the agent searches the archive with the recall tool and quotes the line the earlier command printed.' }
    },
    {
      id: 'hands',
      eyebrow: 'Brain and hands',
      title: 'One brain. As many hands as you need.',
      body: 'The agent loop, memory, models, Skills and MCP connections live on your Foxwarm server, configured once. Nodes are the hands: a build server, a laptop, a container or a browser tab that receives commands and sends results back. Adding a machine means running a small client — no API keys, Skills or MCP setup on every box.',
      points: ['Models, Skills and MCP configured in one place', 'Lightweight Nodes on Linux, macOS, Windows, Docker and the browser', 'Move a session to another machine; the conversation stays put'],
      link: { label: 'Set up a Node', href: docs('nodes/') },
      image: { alt: 'Diagram: the Foxwarm server holds the session runner, memory, models, MCP servers and Skills, including their credentials. Nodes such as a Linux build server, a Windows laptop, a Docker container and a browser tab only exchange commands and results with it.', detailAlt: 'An agent switches its session to the remote Node build-box and runs commands there.' }
    },
    {
      id: 'team',
      eyebrow: 'Sessions and agents',
      title: 'Delegate to a team you can see into.',
      body: 'When an agent hands off a task, the work runs in a real session: it keeps its own history, survives restarts and sits under its parent in the sidebar. Open any of them to see what it is doing, or message it directly to change course. Work can also go to another agent with its own memory, rules and machines.',
      points: ['Every delegated task is a full session you can open and steer', 'Hand work to a different agent, not just a copy of the same one', 'Agent and Node trees where each level can only narrow what it was given'],
      link: { label: 'Agents, sessions and memory', href: docs('agents-sessions-memory/') },
      image: { alt: 'A session that starts two child sessions in parallel — one on the build-box Node, one under a separate docs agent — waits for both and summarizes their reports.', detailAlt: 'Inside a child session: while it works, the user sends it a direct instruction and it adjusts its fix.' }
    },
    {
      id: 'room',
      eyebrow: 'Channels',
      title: 'Work it out here. Explain it in the group.',
      body: 'Any chat can be attached to any session. Work through a problem in the WebUI, add the bot to your team’s group and run /channel attach: it answers with the full history behind it, and anyone in the group can ask a follow-up. Works with Telegram, Matrix, QQ, WeChat and WeCom.',
      points: ['/channel attach connects a chat to an existing session', 'The agent sees who is asking and keeps the whole context', 'Sender allow lists; open a group to everyone while commands stay restricted'],
      link: { label: 'Connect a channel', href: docs('channels/') },
      image: { alt: 'Illustration of a team group chat: a developer attaches the bot to an existing session, asks it to explain a change, and a colleague asks a follow-up question.' }
    }
  ],
  diagram: {
    label: 'Brain and hands',
    brain: 'Brain',
    brainSub: 'Your Foxwarm server',
    brainItems: [
      { text: 'Session runner' },
      { text: 'Memory & history' },
      { text: 'Models', key: true },
      { text: 'MCP servers', key: true },
      { text: 'Skills' }
    ],
    hands: 'Hands',
    handsSub: 'Nodes',
    nodes: [
      { name: 'build-box', kind: 'Linux server' },
      { name: 'dana-laptop', kind: 'Windows' },
      { name: 'sandbox', kind: 'Docker' },
      { name: 'browser', kind: 'Browser Node' }
    ],
    wire: 'commands ⇄ results',
    noKeys: 'No API keys on Nodes'
  },
  advanced: {
    title: 'When you need tighter control',
    items: [
      { title: 'Keys stay with the brain', body: 'Agents can be configured to use models and MCP tools normally without ever being able to read their credentials.' },
      { title: 'Rules per agent', body: 'Allow or deny tools and Nodes for each agent, on top of the instance-wide authorization rules.' },
      { title: 'Agents that organize themselves', body: 'An agent can create sub-agents and give each one part of its Nodes and permissions. No level can exceed what it was given.' }
    ]
  },
  room: {
    title: 'tidepool-dev',
    status: '4 members',
    messages: [
      { from: 'me', text: '/channel attach tidepool/proration', time: '16:02' },
      { from: 'system', text: 'Attached to “Ship the proration fix”.' },
      { from: 'me', text: '@foxwarm Give everyone a two-line summary of the proration change.', time: '16:03' },
      { from: 'bot', name: 'Foxwarm', text: 'prorate() rounded unused time to whole days, so a plan change at noon could credit half a day too much. It now uses the exact time, and all six tests pass on build-box.', time: '16:03' },
      { from: 'member', name: 'Lin', text: 'Does this change credits for switches at midnight?', time: '16:05' },
      { from: 'bot', name: 'Foxwarm', text: 'No. A switch at midnight is a whole number of days, so the credit is exactly the same as before.', time: '16:05' }
    ]
  },
  extras: {
    eyebrow: 'Also built in',
    title: 'Everything an agent needs, in one place.',
    items: [
      { title: 'Terminal and editor', body: 'Real terminals run in the browser next to the conversation, with an optional VS Code–based editor.' },
      { title: 'Agent memory', body: 'Each agent keeps long-lived instructions and knowledge separate from any single conversation.' },
      { title: 'Skills', body: 'Write a workflow once as a Skill; the agent loads it only when a task needs it.' },
      { title: 'Any model', body: 'Use OpenAI-compatible or Anthropic endpoints, including local gateways, and pick a model per session.' },
      { title: 'ToolScript', body: 'Let an agent combine many tool calls in one small script instead of many round trips.' },
      { title: 'Timers', body: 'Give a session one-off or recurring timers so it checks in, reports or follows up on its own.' }
    ]
  },
  start: {
    eyebrow: 'Get started',
    title: 'Up and running in a few minutes.',
    lede: 'Program files and data live in separate directories, so upgrades and backups stay simple.',
    steps: [
      { title: 'Install', body: 'Run the installer for your platform. It downloads a release, starts Foxwarm and prints a sign-in link for the WebUI.' },
      { title: 'Add a model', body: 'Open Setup → Models and enter your provider, model ID and API key.' },
      { title: 'Start a session', body: 'Chat with the default agent, give it a working directory, and add Nodes or Channels whenever you need them.' }
    ],
    guide: 'Full installation guide'
  },
  footer: { tagline: 'Self-hosted AI agents. MIT licensed.', docs: 'Docs', github: 'GitHub', license: 'License' }
};
