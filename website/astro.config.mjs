import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

const github = 'https://github.com/550W-HOST/foxwarm';

export default defineConfig({
  site: 'https://foxwarm.net',
  output: 'static',
  integrations: [
    sitemap({ filter: (page) => page !== 'https://foxwarm.net/404/' }),
    starlight({
      title: 'Foxwarm',
      description: 'Self-hosted AI agents with persistent sessions, tools, and optional nodes and channels.',
      favicon: '/favicon.svg',
      logo: {
        light: './src/assets/foxwarm-wordmark-light.svg',
        dark: './src/assets/foxwarm-wordmark-dark.svg',
        alt: 'Foxwarm',
        replacesTitle: true
      },
      customCss: ['@fontsource-variable/ibm-plex-sans/wght.css', '@fontsource/ibm-plex-mono/400.css', '@fontsource/ibm-plex-mono/500.css', './src/styles/diagram.css', './src/styles/docs.css'],
      social: [{ icon: 'github', label: 'GitHub', href: github }],
      editLink: { baseUrl: `${github}/edit/main/website/` },
      lastUpdated: true,
      disable404Route: true,
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        zh: { label: '简体中文', lang: 'zh-CN' }
      },
      sidebar: [
        { label: 'Get started', translations: { 'zh-CN': '开始' }, items: [
          { label: 'Overview', translations: { 'zh-CN': '概览' }, slug: 'docs' },
          { label: 'Quick start', translations: { 'zh-CN': '快速开始' }, slug: 'docs/quick-start' },
          { label: 'Install Foxwarm', translations: { 'zh-CN': '安装 Foxwarm' }, slug: 'docs/installing' },
          { label: 'Set up your first model', translations: { 'zh-CN': '配置第一个模型' }, slug: 'docs/model-setup' }
        ] },
        { label: 'Concepts', translations: { 'zh-CN': '概念' }, items: [
          { label: 'How Foxwarm works', translations: { 'zh-CN': 'Foxwarm 如何工作' }, slug: 'docs/how-it-works' },
          { label: 'Agents, Sessions, and memory', translations: { 'zh-CN': 'Agent、会话和记忆' }, slug: 'docs/agents-sessions-memory' },
          { label: 'Long conversations', translations: { 'zh-CN': '长对话与历史检索' }, slug: 'docs/history-search' }
        ] },
        { label: 'Use Foxwarm', translations: { 'zh-CN': '使用' }, items: [
          { label: 'Delegate work', translations: { 'zh-CN': '委派与协作' }, slug: 'docs/delegation' },
          { label: 'Nodes', translations: { 'zh-CN': '节点' }, slug: 'docs/nodes' },
          { label: 'Channels and group chats', translations: { 'zh-CN': '渠道与群聊' }, slug: 'docs/channels' },
          { label: 'Tools, Skills, and MCP', translations: { 'zh-CN': '工具、Skill 和 MCP' }, slug: 'docs/tools-skills-mcp' },
          { label: 'Timers', translations: { 'zh-CN': '定时任务' }, slug: 'docs/timers' },
          { label: 'Using the WebUI', translations: { 'zh-CN': '使用 WebUI' }, slug: 'docs/webui' }
        ] },
        { label: 'Control and security', translations: { 'zh-CN': '权限与安全' }, items: [
          { label: 'Access control', translations: { 'zh-CN': '访问控制' }, slug: 'docs/access-control' },
          { label: 'External MCP clients', translations: { 'zh-CN': '外部 MCP 客户端' }, slug: 'docs/mcp-inbound' }
        ] },
        { label: 'Operate', translations: { 'zh-CN': '运维' }, items: [
          { label: 'Data, upgrades, and backups', translations: { 'zh-CN': '数据、升级与备份' }, slug: 'docs/data-upgrades-backups' },
          { label: 'Model options and routing', translations: { 'zh-CN': '模型选项与路由' }, slug: 'docs/model-options' },
          { label: 'Migrate from TypeScript', translations: { 'zh-CN': '从 TypeScript 版迁移' }, slug: 'docs/typescript-migration' },
          { label: 'FAQ', slug: 'docs/faq' }
        ] }
      ],
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#f36a2f' } },
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'Foxwarm' } }
      ]
    })
  ]
});
