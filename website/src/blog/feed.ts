// RSS 2.0 feed of the blog index in one language: the same entries, newest first.
import { siteUrl, blogPath, strings, type Lang } from '../i18n/home';
import { blogStrings } from '../i18n/blog';
import { getPostGroups, preferredVersion } from './posts';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function blogFeed(lang: Lang): Promise<Response> {
  const b = blogStrings[lang];
  const index = siteUrl + blogPath(lang);
  const items = (await getPostGroups()).map((group) => {
    const { post, lang: postLang } = preferredVersion(group, lang);
    const url = siteUrl + blogPath(postLang, group.slug);
    return [
      '    <item>',
      `      <title>${escape(post.data.title)}</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="true">${url}</guid>`,
      `      <pubDate>${post.data.date.toUTCString()}</pubDate>`,
      `      <description>${escape(post.data.description)}</description>`,
      '    </item>'
    ].join('\n');
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escape(b.feedTitle)}</title>`,
    `    <link>${index}</link>`,
    `    <description>${escape(b.description)}</description>`,
    `    <language>${strings[lang].htmlLang}</language>`,
    `    <atom:link href="${index}rss.xml" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
    ''
  ].join('\n');
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
