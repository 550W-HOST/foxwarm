export type Lang = 'en' | 'zh';

export const githubUrl = 'https://github.com/550W-HOST/foxwarm';
export const siteUrl = 'https://foxwarm.net';

export const installCommands = {
  linux: `curl -fsSL ${siteUrl}/install-foxwarm.sh | bash`,
  windows: `irm ${siteUrl}/install-foxwarm.ps1 | iex`,
  docker: `git clone ${githubUrl}.git && cd foxwarm\nmkdir -p foxwarm-data/state foxwarm-data/agents\ndocker compose up -d --build foxwarm`
};

type Feature = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  link: { label: string; href: string };
  image: { alt: string };
};

type Extra = { title: string; body: string };

export type HomeStrings = {
  htmlLang: string;
  path: string;
  meta: { title: string; description: string; ogTitle: string };
  nav: { features: string; install: string; docs: string; github: string; theme: string; language: string; languageLabel: string; skip: string };
  hero: {
    eyebrow: string;
    titleLines: [string, string];
    lede: string;
    primary: string;
    secondary: string;
    screenshotAlt: string;
  };
  install: {
    tabs: { linux: string; windows: string; docker: string };
    copy: string;
    copied: string;
    notes: { linux: string; windows: string; docker: string };
    requirementsLink: string;
  };
  strip: { label: string; items: string[] };
  features: Feature[];
  channelsDemo: {
    title: string;
    status: string;
    messages: { from: 'user' | 'bot'; text: string; time: string }[];
  };
  extras: { eyebrow: string; title: string; items: Extra[] };
  start: {
    eyebrow: string;
    title: string;
    lede: string;
    steps: { title: string; body: string }[];
    guide: string;
  };
  final: { title: string; body: string; primary: string; secondary: string };
  footer: { tagline: string; docs: string; github: string; license: string };
};

const docs = (lang: Lang, page = '') => `/docs/${page}`;

export const strings: Record<Lang, HomeStrings> = {
  en: {
    htmlLang: 'en',
    path: '/',
    meta: {
      title: 'Foxwarm — self-hosted AI agents that keep working',
      description: 'Foxwarm is an open-source, self-hosted workspace for long-running AI agents: persistent sessions, parallel child sessions, tools on any machine, and chat-app access.',
      ogTitle: 'Foxwarm — self-hosted AI agents that keep working'
    },
    nav: { features: 'Features', install: 'Install', docs: 'Docs', github: 'GitHub', theme: 'Switch color theme', language: '中文', languageLabel: '切换到中文', skip: 'Skip to content' },
    hero: {
      eyebrow: 'Open source · Self-hosted · MIT',
      titleLines: ['AI agents that keep working,', 'on machines you own.'],
      lede: 'Foxwarm is a self-hosted workspace for long-running agents. They read your code, run commands, split work across parallel sessions, and pick up where they left off — in the browser or in the chat app you already use.',
      primary: 'Install Foxwarm',
      secondary: 'Read the docs',
      screenshotAlt: 'The Foxwarm WebUI: an agent session fixing a failing test suite, with tool calls, a commit, and a summary of the cause and fix. The sidebar lists other sessions, including a release session with two child sessions.'
    },
    install: {
      tabs: { linux: 'Linux / WSL', windows: 'Windows', docker: 'Docker' },
      copy: 'Copy',
      copied: 'Copied',
      notes: {
        linux: 'Linux x64 and x64 WSL. Builds from source; needs Git, Node.js, the .NET 10 SDK and a few build tools.',
        windows: 'Windows x64, in PowerShell. Builds from source; needs Git, Node.js, the .NET 10 SDK and Python 3.',
        docker: 'Linux x64 with Docker Compose. Everything builds inside the image.'
      },
      requirementsLink: 'Prerequisites and options'
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
        link: { label: 'How compaction and recall work', href: docs('en', 'history-search/') },
        image: { alt: 'A Foxwarm session after compaction: earlier turns are folded into a summary block, and the agent uses the recall tool to quote an exact earlier message.' }
      },
      {
        id: 'parallel',
        eyebrow: 'Parallel sessions',
        title: 'Split the work. Keep one thread.',
        body: 'An agent can hand well-defined tasks to child sessions that run in parallel — one audits a function, another drafts the changelog — and report back when they finish. Each session keeps its own context while sharing the agent’s workspace and memory.',
        points: ['Child sessions with their own context and model', 'Reports arrive back in the parent session', 'Shared Tasks to track what is still open'],
        link: { label: 'Agents, sessions and memory', href: docs('en', 'agents-sessions-memory/') },
        image: { alt: 'A release session that starts two child sessions, waits for both, and receives their reports. The sidebar shows the children nested under the parent.' }
      },
      {
        id: 'nodes',
        eyebrow: 'Nodes',
        title: 'Run tools where the work is.',
        body: 'Tools run on a Node: the Foxwarm host itself, a server across the network, a Docker container, or your own browser through an extension. Switch a session’s Node and the same file and shell tools follow; the conversation and memory stay where they are.',
        points: ['Pair Linux, macOS and Windows machines', 'Share browser tabs through Browser Node', 'Connect MCP servers, or expose Foxwarm as one'],
        link: { label: 'Set up a Node', href: docs('en', 'nodes/') },
        image: { alt: 'An agent switches its session to a remote Node called build-box, checks the machine, and runs the test suite there.' }
      },
      {
        id: 'channels',
        eyebrow: 'Channels',
        title: 'Reach it from the apps you already use.',
        body: 'Connect a session to Telegram, Matrix, QQ, WeChat or WeCom and keep working away from your desk. Messages land in the same session you use in the WebUI, with the same tools and history.',
        points: ['One session across WebUI and chat', 'Allow lists for each channel', 'Progress updates during long tasks'],
        link: { label: 'Connect a channel', href: docs('en', 'channels/') },
        image: { alt: 'Illustration of a chat app conversation with a Foxwarm agent.' }
      }
    ],
    channelsDemo: {
      title: 'Foxwarm',
      status: 'bot',
      messages: [
        { from: 'user', text: 'Did the v0.5.0 release checks finish?', time: '21:04' },
        { from: 'bot', text: 'Yes. Tests pass on master and build-box (6/6). The proration fix is in, CHANGELOG.md is updated, and the version is bumped to 0.5.0.', time: '21:04' },
        { from: 'user', text: 'Great, tag it and push.', time: '21:05' },
        { from: 'bot', text: 'Tagged v0.5.0 and pushed. I’ll keep an eye on CI and message you if anything fails.', time: '21:05' }
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
        { title: 'Access control', body: 'Tool authorization rules and scoped WebUI access for instances you share with others.' }
      ]
    },
    start: {
      eyebrow: 'Get started',
      title: 'Up and running in a few minutes.',
      lede: 'Program files and data live in separate directories, so upgrades and backups stay simple.',
      steps: [
        { title: 'Install', body: 'Run the installer for your platform. It builds Foxwarm, starts it, and prints a sign-in link for the WebUI.' },
        { title: 'Add a model', body: 'Open Setup → Models and enter your provider, model ID and API key.' },
        { title: 'Start a session', body: 'Chat with the default agent, give it a working directory, and add Nodes or Channels whenever you need them.' }
      ],
      guide: 'Full installation guide'
    },
    final: {
      title: 'Bring your agents home.',
      body: 'Free and open source under the MIT license.',
      primary: 'Install Foxwarm',
      secondary: 'Star on GitHub'
    },
    footer: { tagline: 'Self-hosted AI agents. MIT licensed.', docs: 'Docs', github: 'GitHub', license: 'License' }
  },
  zh: {
    htmlLang: 'zh-CN',
    path: '/zh/',
    meta: {
      title: 'Foxwarm — 在你自己的机器上持续工作的 AI Agent',
      description: 'Foxwarm 是开源、自托管的 AI Agent 工作台：会话持久保存，子会话并行协作，工具可以跑在任何机器上，还能从聊天软件直接使用。',
      ogTitle: 'Foxwarm — 在你自己的机器上持续工作的 AI Agent'
    },
    nav: { features: '功能', install: '安装', docs: '文档', github: 'GitHub', theme: '切换配色', language: 'English', languageLabel: 'Switch to English', skip: '跳到正文' },
    hero: {
      eyebrow: '开源 · 自托管 · MIT 协议',
      titleLines: ['持续工作的 AI Agent，', '运行在你自己的机器上。'],
      lede: 'Foxwarm 是一个自托管的 Agent 工作台。Agent 能读代码、跑命令、把任务拆给多个并行会话，重启之后接着干。你可以在浏览器里用它，也可以在常用的聊天软件里找它。',
      primary: '安装 Foxwarm',
      secondary: '阅读文档',
      screenshotAlt: 'Foxwarm WebUI：一个 Agent 会话正在修复失败的测试，界面中有工具调用、提交记录以及对原因和修复方式的总结。侧边栏列出了其他会话，其中一个发布会话下有两个子会话。'
    },
    install: {
      tabs: { linux: 'Linux / WSL', windows: 'Windows', docker: 'Docker' },
      copy: '复制',
      copied: '已复制',
      notes: {
        linux: '支持 Linux x64 和 x64 WSL。从源码构建，需要 Git、Node.js、.NET 10 SDK 和少量编译工具。',
        windows: '支持 Windows x64，在 PowerShell 中运行。从源码构建，需要 Git、Node.js、.NET 10 SDK 和 Python 3。',
        docker: '适用于装有 Docker Compose 的 Linux x64，所有依赖都在镜像内构建。'
      },
      requirementsLink: '依赖和安装选项'
    },
    strip: {
      label: '兼容',
      items: ['OpenAI 兼容 API', 'Anthropic', '本地网关', 'MCP', 'Telegram', 'Matrix', 'QQ', '微信', '企业微信']
    },
    features: [
      {
        id: 'memory',
        eyebrow: '长时间运行',
        title: '对话再长，也不会失忆。',
        body: '会话接近模型的上下文上限时，Foxwarm 会把较早的内容压缩成分层摘要，而不是直接丢掉。原始消息保留在归档里，某个细节重新变得重要时，Agent 可以把原文找回来。服务重启后，会话也会接着进行。',
        points: ['分层摘要，每一层都能追溯到原文', '精确回溯归档中的消息', '可选的跨会话语义检索'],
        link: { label: '了解压缩和回溯', href: docs('zh', 'history-search/') },
        image: { alt: '压缩后的 Foxwarm 会话：较早的对话被折叠为摘要块，Agent 使用回溯工具引用了之前的一条原始消息。' }
      },
      {
        id: 'parallel',
        eyebrow: '并行会话',
        title: '任务拆开做，主线不乱。',
        body: 'Agent 可以把边界清楚的任务交给子会话并行处理，比如一个审查函数的边界情况，一个起草更新日志，完成后再把结果汇报回来。每个会话有独立的上下文，同时共享 Agent 的工作区和记忆。',
        points: ['子会话有独立的上下文，也可以用不同的模型', '结果自动汇报回父会话', '用 Task 跟踪还没完成的工作'],
        link: { label: 'Agent、会话和记忆', href: docs('zh', 'agents-sessions-memory/') },
        image: { alt: '一个发布会话启动两个子会话，等待两者完成并收到它们的汇报。侧边栏中子会话嵌套在父会话下面。' }
      },
      {
        id: 'nodes',
        eyebrow: '节点',
        title: '工具跑在需要它的地方。',
        body: '工具在节点（Node）上执行：可以是 Foxwarm 所在的主机、网络里的另一台服务器、一个 Docker 容器，或者通过扩展接入的你自己的浏览器。切换会话的节点，文件和命令工具就跟着过去，对话和记忆留在原处。',
        points: ['接入 Linux、macOS 和 Windows 机器', '通过 Browser Node 共享浏览器标签页', '连接 MCP 服务器，也能把 Foxwarm 作为 MCP 服务提供出去'],
        link: { label: '配置节点', href: docs('zh', 'nodes/') },
        image: { alt: 'Agent 把会话切换到名为 build-box 的远程节点，检查机器状态并在那里运行测试。' }
      },
      {
        id: 'channels',
        eyebrow: '渠道',
        title: '在常用的聊天软件里找到它。',
        body: '把会话接入 Telegram、Matrix、QQ、微信或企业微信，离开电脑也能继续工作。消息进入的就是你在 WebUI 里用的那个会话，工具和历史完全一致。',
        points: ['WebUI 和聊天软件共用同一个会话', '每个渠道单独配置允许的用户', '长任务执行中可以推送进度'],
        link: { label: '接入渠道', href: docs('zh', 'channels/') },
        image: { alt: '示意图：在聊天软件中与 Foxwarm Agent 对话。' }
      }
    ],
    channelsDemo: {
      title: 'Foxwarm',
      status: '机器人',
      messages: [
        { from: 'user', text: 'v0.5.0 的发布检查跑完了吗？', time: '21:04' },
        { from: 'bot', text: '跑完了。master 和 build-box 上测试都通过（6/6）。proration 的修复已经合入，CHANGELOG.md 也更新了，版本号改成了 0.5.0。', time: '21:04' },
        { from: 'user', text: '好，打 tag 推上去吧。', time: '21:05' },
        { from: 'bot', text: '已经打好 v0.5.0 并推送。我会盯着 CI，有失败会马上告诉你。', time: '21:05' }
      ]
    },
    extras: {
      eyebrow: '同样内置',
      title: 'Agent 需要的，都在一个地方。',
      items: [
        { title: '终端和编辑器', body: '真实终端直接在浏览器里运行，就在对话旁边；还可以选装基于 VS Code 的编辑器。' },
        { title: 'Agent 记忆', body: '每个 Agent 都有长期保存的指令和知识，不依赖某一次对话。' },
        { title: 'Skill', body: '把工作流程写成 Skill，Agent 只在任务需要时才加载。' },
        { title: '模型随你选', body: '支持 OpenAI 兼容和 Anthropic 接口，也支持本地网关，每个会话都可以选不同的模型。' },
        { title: 'ToolScript', body: 'Agent 可以用一段小脚本组合多次工具调用，省去来回往返。' },
        { title: '权限控制', body: '工具授权规则和限定范围的 WebUI 访问，适合和别人共用的实例。' }
      ]
    },
    start: {
      eyebrow: '开始使用',
      title: '几分钟就能跑起来。',
      lede: '程序文件和数据放在不同的目录里，升级和备份都很简单。',
      steps: [
        { title: '安装', body: '运行对应平台的安装脚本。它会构建并启动 Foxwarm，然后输出 WebUI 的登录链接。' },
        { title: '添加模型', body: '打开 Setup → Models，填写服务商、模型 ID 和 API Key。' },
        { title: '开始会话', body: '和默认 Agent 对话，给它指定工作目录；需要时再添加节点或渠道。' }
      ],
      guide: '完整安装指南'
    },
    final: {
      title: '把你的 Agent 带回家。',
      body: '基于 MIT 协议免费开源。',
      primary: '安装 Foxwarm',
      secondary: '在 GitHub 上 Star'
    },
    footer: { tagline: '自托管的 AI Agent，MIT 协议开源。', docs: '文档', github: 'GitHub', license: '许可证' }
  }
};
