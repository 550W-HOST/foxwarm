import { en } from './home.en';
import { zh } from './home.zh';

export type Lang = 'en' | 'zh';

export const githubUrl = 'https://github.com/550W-HOST/foxwarm';
export const siteUrl = 'https://foxwarm.net';

export const installCommands = {
  linux: `curl -fsSL ${siteUrl}/install-foxwarm.sh | bash`,
  windows: `irm ${siteUrl}/install-foxwarm.ps1 | iex`,
  docker: `docker run -d --name foxwarm --init -p 3001:3001 \\\n  -v "$PWD/foxwarm-data:/data" ghcr.io/550w-host/foxwarm:latest`
};

export type FeatureVisual = 'memory' | 'hands' | 'team' | 'room';

export type Feature = {
  id: FeatureVisual;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  link: { label: string; href: string };
  image: { alt: string; detailAlt?: string };
};

export type ChatMessage = { from: 'me' | 'member' | 'bot' | 'system'; name?: string; text: string; time?: string };

export type HomeStrings = {
  htmlLang: string;
  path: string;
  meta: { title: string; description: string; ogTitle: string };
  nav: { features: string; install: string; docs: string; github: string; theme: string; language: string; languageLabel: string; skip: string };
  hero: { eyebrow: string; titleLines: [string, string]; lede: string; primary: string; secondary: string; screenshotAlt: string };
  install: {
    tabs: { linux: string; windows: string; docker: string };
    copy: string;
    copied: string;
    notes: { linux: string; windows: string; docker: string };
    requirementsLink: string;
  };
  strip: { label: string; items: string[] };
  features: Feature[];
  diagram: {
    label: string;
    brain: string;
    brainSub: string;
    brainItems: { text: string; key?: boolean }[];
    hands: string;
    handsSub: string;
    nodes: { name: string; kind: string }[];
    wire: string;
    noKeys: string;
  };
  advanced: { title: string; items: { title: string; body: string }[] };
  room: { title: string; status: string; messages: ChatMessage[] };
  extras: { eyebrow: string; title: string; items: { title: string; body: string }[] };
  start: { eyebrow: string; title: string; lede: string; steps: { title: string; body: string }[]; guide: string };
  final: { title: string; body: string; primary: string; secondary: string };
  footer: { tagline: string; docs: string; github: string; license: string };
};

export const docs = (_lang: Lang, page = '') => `/docs/${page}`;

export const strings: Record<Lang, HomeStrings> = { en, zh };
