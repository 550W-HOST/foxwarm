import type { Lang } from './home';

export type BlogStrings = {
  title: string;
  /** Index lede and meta description. */
  description: string;
  feedTitle: string;
  feed: string;
  /** Badge on an index entry that exists only in the other language. */
  otherLanguageOnly: string;
  allPosts: string;
  appliesTo: (version: string) => string;
  formatDate: (date: Date) => string;
};

export const blogStrings: Record<Lang, BlogStrings> = {
  en: {
    title: 'Blog',
    description: 'Agent Design Notes: each post takes one general question in agent design, compares how other agents answer it, and explains the trade-off Foxwarm makes and the evidence behind it. Posts appear in Chinese first; English versions follow.',
    feedTitle: 'Foxwarm Blog',
    feed: 'RSS feed',
    otherLanguageOnly: 'Chinese only for now',
    allPosts: 'All posts',
    appliesTo: (version) => `Applies to ${version}`,
    formatDate: (date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date)
  },
  zh: {
    title: '博客',
    description: 'Agent 设计笔记：每篇讲一个通用的 agent 设计问题，对比各家的做法，说明 Foxwarm 的取舍和依据。文章先写中文，英文版随后补上。',
    feedTitle: 'Foxwarm 博客',
    feed: 'RSS 订阅',
    otherLanguageOnly: '暂只有英文',
    allPosts: '全部文章',
    appliesTo: (version) => `适用于 ${version}`,
    formatDate: (date) => `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`
  }
};
