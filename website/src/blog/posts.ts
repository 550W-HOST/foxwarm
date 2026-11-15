// Blog posts live at src/content/blog/<slug>/<lang>.md. Files that share a slug are
// translations of one post; a post may exist in one language only.
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n/home';

export type Post = CollectionEntry<'blog'>;
export type PostGroup = { slug: string; date: Date; versions: Partial<Record<Lang, Post>> };

const languages: readonly Lang[] = ['en', 'zh'];

function parseId(post: Post): { slug: string; lang: Lang } {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(en|zh)$/.exec(post.id);
  if (!match) throw new Error(`Blog post ${post.id}: expected src/content/blog/<slug>/<en|zh>.md`);
  return { slug: match[1], lang: match[2] as Lang };
}

/** All posts, newest first, each with the languages it exists in. */
export async function getPostGroups(): Promise<PostGroup[]> {
  const groups = new Map<string, PostGroup>();
  for (const post of await getCollection('blog')) {
    const { slug, lang } = parseId(post);
    const group = groups.get(slug) ?? { slug, date: post.data.date, versions: {} };
    group.versions[lang] = post;
    if (post.data.date < group.date) group.date = post.data.date;
    groups.set(slug, group);
  }
  return [...groups.values()].sort((a, b) => b.date.getTime() - a.date.getTime() || a.slug.localeCompare(b.slug));
}

/** The version to show readers of `lang`: their own language, else the other one. */
export function preferredVersion(group: PostGroup, lang: Lang): { post: Post; lang: Lang } {
  const own = group.versions[lang];
  if (own) return { post: own, lang };
  const other = languages.find((candidate) => candidate !== lang && group.versions[candidate])!;
  return { post: group.versions[other]!, lang: other };
}
