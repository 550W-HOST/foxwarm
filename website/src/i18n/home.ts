import { en } from './home.en';
import { zh } from './home.zh';

export type Lang = 'en' | 'zh';

/** Each language's name, written in that language. */
export const languageNames: Record<Lang, string> = { en: 'English', zh: '中文' };

export const githubUrl = 'https://github.com/550W-HOST/foxwarm';
export const siteUrl = 'https://foxwarm.net';

// Release files at stable URLs that always serve the latest release.
export const latestReleaseUrl = `${githubUrl}/releases/latest`;
const latestReleaseFile = (name: string) => `${latestReleaseUrl}/download/${name}`;

// The visitor platform (see src/scripts/platform.mjs) that each download is emphasized for.
export type DownloadPlatform = 'windows' | 'macos' | 'android';
export type DownloadFile = { file: string; href: string; platform: DownloadPlatform };
export const downloadFiles = {
  windowsDesktop: { file: 'foxwarm-desktop-win-x64.zip', href: latestReleaseFile('foxwarm-desktop-win-x64.zip'), platform: 'windows' },
  macDesktop: { file: 'foxwarm-desktop-osx-arm64.zip', href: latestReleaseFile('foxwarm-desktop-osx-arm64.zip'), platform: 'macos' },
  // The site's /android redirect, also printed as a QR code in the installing guide.
  androidNode: { file: 'foxwarm-android-node.apk', href: '/android', platform: 'android' }
} satisfies Record<string, DownloadFile>;

export const installCommands = {
  linux: `curl -fsSL ${siteUrl}/install-foxwarm.sh | bash`,
  windows: `irm ${siteUrl}/install-foxwarm.ps1 | iex`,
  // The same steps as the installing guide: the container runs as uid 1000, and the seccomp profile keeps
  // Chromium's sandbox working. Lines stay short enough to show whole beside the copy button on desktops.
  docker: [
    'mkdir -p foxwarm-data',
    'sudo chown 1000:1000 foxwarm-data',
    `curl -fsSLO ${siteUrl}/seccomp-chromium.json`,
    'docker run -d --name foxwarm --init -p 3001:3001 \\',
    '  --security-opt seccomp=seccomp-chromium.json \\',
    '  --shm-size 1g -v "$PWD/foxwarm-data:/data" \\',
    '  ghcr.io/550w-host/foxwarm:latest'
  ].join('\n')
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

type Link = { label: string; href: string };
// One way to get Foxwarm: its name, platform detail, what to know before using it and the guide section with the steps.
export type DownloadOption = { name: string; detail?: string; note: string; guide: Link };

export type ChatMessage = { from: 'me' | 'member' | 'bot' | 'system'; name?: string; text: string; time?: string };

export type HomeStrings = {
  htmlLang: string;
  path: string;
  meta: { title: string; description: string; ogTitle: string };
  nav: { features: string; install: string; docs: string; demo: string; blog: string; download: string; github: string; theme: string; language: string; languageLabel: string; languageMenu: string; skip: string };
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
    more: string;
  };
  downloads: {
    title: string;
    download: string;
    current: string;
    desktop: { title: string; body: string; windows: DownloadOption; mac: DownloadOption };
    server: { title: string; body: string; installers: DownloadOption; docker: DownloadOption; packages: Link };
    android: { title: string; body: string; app: DownloadOption };
    release: string;
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
  footer: { tagline: string; docs: string; download: string; blog: string; github: string; license: string };
};

export const docsPath = (lang: Lang, page = '') => `${lang === 'zh' ? '/zh' : ''}/docs/${page}`;
export const blogPath = (lang: Lang, slug = '') => `${lang === 'zh' ? '/zh' : ''}/blog/${slug ? `${slug}/` : ''}`;

export const strings: Record<Lang, HomeStrings> = { en, zh };
