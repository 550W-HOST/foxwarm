import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

const github = 'https://github.com/550W-HOST/foxwarm';

export default defineConfig({
  site: 'https://foxwarm.550w.host',
  output: 'static',
  integrations: [
    sitemap({ filter: (page) => page !== 'https://foxwarm.550w.host/404/' }),
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
      customCss: ['./src/styles/docs.css'],
      social: [{ icon: 'github', label: 'GitHub', href: github }],
      editLink: { baseUrl: `${github}/edit/main/website/` },
      lastUpdated: true,
      disable404Route: true,
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Documentation', slug: 'docs' },
          { label: 'Install Foxwarm', slug: 'docs/installing' },
          { label: 'Set up your first model', slug: 'docs/model-setup' }
        ] },
        { label: 'Use Foxwarm', items: [
          { label: 'Agents, sessions, and memory', slug: 'docs/agents-sessions-memory' },
          { label: 'Tools, skills, and MCP', slug: 'docs/tools-skills-mcp' },
          { label: 'Optional Nodes', slug: 'docs/nodes' },
          { label: 'Channels', slug: 'docs/channels' }
        ] },
        { label: 'Operate your instance', items: [
          { label: 'Data, upgrades, and backups', slug: 'docs/data-upgrades-backups' },
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
