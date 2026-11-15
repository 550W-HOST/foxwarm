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

// The static WebUI demo replays recorded, fictional Sessions; `#session/<id>` opens one directly.
export const demoUrl = '/demo/';
export const demoSession = (sessionId: string) => `${demoUrl}#session/${encodeURIComponent(sessionId)}`;
// The hero screenshot shows this Session.
export const heroDemoSession = 'tidepool/fix-ci';
// Recorded Sessions that show each feature. The channel example has no counterpart in the recording.
export const featureDemoSessions: Partial<Record<FeatureVisual, string>> = {
  memory: 'tidepool/support',
  hands: 'tidepool/runner',
  team: 'tidepool/proration-v2'
};

export type Feature = {
  id: FeatureVisual;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  link: { label: string; href: string };
  image: { alt: string; detailAlt?: string };
};

export type TimelineRow = { time: string; place?: string; icon?: 'laptop' | 'server' | 'phone' | 'chat' | 'moon' | 'memory'; text: string; quote?: string; highlight?: boolean };

export type ChatMessage = { from: 'me' | 'member' | 'bot' | 'system'; name?: string; text: string; time?: string };

export type HomeStrings = {
  htmlLang: string;
  path: string;
  meta: { title: string; description: string; ogTitle: string };
  nav: { features: string; install: string; docs: string; demo: string; github: string; theme: string; language: string; languageLabel: string; skip: string };
  hero: {
    title: string;
    lede: string;
    timeline: {
      label: string;
      rows: TimelineRow[];
      footer: string;
      link: string;
    };
    shotCaption: string;
    screenshotAlt: string;
    demo: { link: string; note: string };
  };
  featureDemo: string;
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
  footer: { tagline: string; docs: string; github: string; license: string };
};

export const docs = (_lang: Lang, page = '') => `/docs/${page}`;

export const strings: Record<Lang, HomeStrings> = { en, zh };
