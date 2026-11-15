import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  // src/content/blog/<slug>/<en|zh>.md; see src/blog/posts.ts.
  blog: defineCollection({
    loader: glob({ pattern: '*/{en,zh}.md', base: './src/content/blog' }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      series: z.string().optional(),
      version: z.string().optional()
    })
  })
};
