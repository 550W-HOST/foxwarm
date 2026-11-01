import type { HomeStrings } from './home';

const docs = (page = '') => `/docs/${page}`;

export const zh: HomeStrings = {
  htmlLang: 'zh-CN',
  path: '/zh/',
  meta: {
    title: 'Foxwarm — 在你自己的机器上持续工作的 AI Agent',
    description: 'Foxwarm 是开源、自托管的 AI Agent 工作台：Agent loop、模型和记忆集中在一台服务器上，轻量的节点负责在任意机器上执行工具。委派出去的任务都是能打开查看的会话，任何会话都能拉进群聊。',
    ogTitle: 'Foxwarm — 在你自己的机器上持续工作的 AI Agent'
  },
  nav: { features: '功能', install: '安装', docs: '文档', github: 'GitHub', theme: '切换配色', language: 'English', languageLabel: 'Switch to English', skip: '跳到正文' },
  hero: {
    eyebrow: '开源 · 自托管 · MIT 协议',
    titleLines: ['持续工作的 AI Agent，', '运行在你自己的机器上。'],
    lede: 'Foxwarm 是一个自托管的 Agent 工作台。Agent 能读代码、在你接入的机器上跑命令、把任务交给其他会话，重启之后接着干。你可以在浏览器里用它，也可以把它拉进团队群聊。',
    primary: '安装 Foxwarm',
    secondary: '阅读文档',
    screenshotAlt: 'Foxwarm WebUI 的 Conversation 视图：用户请 Agent 修复失败的测试，Agent 汇报了原因、修复方式和提交记录。侧边栏列出了其他会话，其中一些带有子会话。'
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
      link: { label: '了解压缩和回溯', href: docs('history-search/') },
      image: { alt: '压缩后的 Foxwarm 会话：用户要求给出某个工单背后的原始输出，Agent 用 recall 工具检索归档，并引用了之前命令打印的那一行。' }
    },
    {
      id: 'hands',
      eyebrow: '手脑分离',
      title: '一个大脑，任意多双手。',
      body: 'Agent loop、记忆、模型、Skill 和 MCP 连接都在你的 Foxwarm 服务器上，只需配置一次。节点就是手：构建服务器、笔记本、容器或浏览器标签页，负责接收指令、回传结果。新增一台机器只需运行一个小客户端，不用在每台机器上配置 API Key、Skill 或 MCP。',
      points: ['模型、Skill 和 MCP 集中在一处配置', '轻量节点，支持 Linux、macOS、Windows、Docker 和浏览器', '会话可以换到另一台机器上干活，对话留在原处'],
      link: { label: '配置节点', href: docs('nodes/') },
      image: { alt: '示意图：Foxwarm 服务器上有会话运行器、记忆、模型、MCP 服务器和 Skill，凭据也只在这里。Linux 构建服务器、Windows 笔记本、Docker 容器和浏览器标签页等节点只和它交换指令与结果。', detailAlt: 'Agent 把会话切换到远程节点 build-box，并在那里执行命令。' }
    },
    {
      id: 'team',
      eyebrow: '会话与 Agent',
      title: '派出去的活，随时看得见、管得住。',
      body: 'Agent 把任务交出去时，工作在一个真正的会话里进行：它有自己的历史，重启后还在，在侧边栏里挂在父会话下面。你可以随时点开看它在做什么，也可以直接给它发消息调整方向。任务还可以交给另一个 Agent，它有自己的记忆、规则和机器。',
      points: ['每个委派的任务都是能打开、能插话的完整会话', '可以交给另一个 Agent，而不只是同一个 Agent 的分身', 'Agent 树和节点树，每一层只能在上级给的范围内再收窄'],
      link: { label: 'Agent、会话和记忆', href: docs('agents-sessions-memory/') },
      image: { alt: '一个会话并行启动两个子会话：一个在 build-box 节点上，一个在单独的文档 Agent 下；等两者完成后汇总它们的汇报。', detailAlt: '子会话内部：它工作期间，用户直接给它发了一条指令，它随之调整了修复方式。' }
    },
    {
      id: 'room',
      eyebrow: '渠道',
      title: '在这里聊清楚，再拉进群里讲。',
      body: '任何聊天都可以绑定到任何会话。先在 WebUI 里把问题理清楚，再把 bot 拉进团队群，执行 /attach：它带着前面完整的上下文回答，群里任何人都可以接着追问。支持 Telegram、Matrix、QQ、微信和企业微信。',
      points: ['用 /attach 把聊天接到已有会话', 'Agent 知道是谁在问，上下文完整保留', '发送者白名单；可以对某个群放开追问，命令仍只限授权用户'],
      link: { label: '接入渠道', href: docs('channels/') },
      image: { alt: '示意图：团队群聊中，开发者把 bot 绑定到已有会话，请它解释一项改动，同事接着追问。' }
    }
  ],
  diagram: {
    label: '手脑分离',
    brain: '大脑',
    brainSub: '你的 Foxwarm 服务器',
    brainItems: [
      { text: '会话运行器' },
      { text: '记忆与历史' },
      { text: '模型', key: true },
      { text: 'MCP 服务器', key: true },
      { text: 'Skill' }
    ],
    hands: '手',
    handsSub: '节点',
    nodes: [
      { name: 'build-box', kind: 'Linux 服务器' },
      { name: 'dana-laptop', kind: 'Windows' },
      { name: 'sandbox', kind: 'Docker' },
      { name: 'browser', kind: 'Browser Node' }
    ],
    wire: '指令 ⇄ 结果',
    noKeys: '节点上没有 API Key'
  },
  advanced: {
    title: '需要更严格的控制时',
    items: [
      { title: '凭据只留在大脑', body: '可以配置成：Agent 正常使用模型和 MCP 工具，但始终读不到它们的凭据。' },
      { title: '按 Agent 设置规则', body: '在实例级授权规则之上，为每个 Agent 单独允许或禁止工具和节点。' },
      { title: '让 Agent 自己分层', body: 'Agent 可以创建下级 Agent，把自己的一部分节点和权限分给它。每一层都不能超出上级给的范围。' }
    ]
  },
  room: {
    title: 'tidepool 开发群',
    status: '4 位成员',
    messages: [
      { from: 'me', text: '/attach tidepool/proration', time: '16:02' },
      { from: 'system', text: '已绑定到“Ship the proration fix”。' },
      { from: 'me', text: '@foxwarm 用两句话给大家讲讲 proration 这次改了什么', time: '16:03' },
      { from: 'bot', name: 'Foxwarm', text: '原来 prorate() 把剩余时间取整到天，中午换套餐会多退半天的钱。现在按精确时间计算，build-box 上 6 个测试全部通过。', time: '16:03' },
      { from: 'member', name: 'Lin', text: '零点换套餐的退款会变吗？', time: '16:05' },
      { from: 'bot', name: 'Foxwarm', text: '不会。零点切换正好是整天，退款和以前完全一样。', time: '16:05' }
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
      { title: '定时任务', body: '给会话设置一次性或周期性的定时器，让它按时检查、汇报或跟进。' }
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
  final: { title: '把你的 Agent 带回家。', body: '基于 MIT 协议免费开源。', primary: '安装 Foxwarm', secondary: '在 GitHub 上 Star' },
  footer: { tagline: '自托管的 AI Agent，MIT 协议开源。', docs: '文档', github: 'GitHub', license: '许可证' }
};
