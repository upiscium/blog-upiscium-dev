import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be a lowercase URL path segment.')
  .optional();

const originUrl = z
  .url()
  .refine((url) => {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'Origin URL must use the http or https protocol.');

const safeOriginUrl = originUrl.refine((url) => {
  const parsedUrl = new URL(url);
  return !parsedUrl.username && !parsedUrl.password;
}, 'Origin URL must not include a username or password.');

const origin = z
  .object({
    platform: z.string(),
    url: safeOriginUrl,
  })
  .optional();

const tag = z
  .string()
  .min(1, 'Tags must not be empty.')
  .refine((value) => value.trim().length > 0, 'Tags must not be whitespace only.');

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    slug,
    lang: z.enum(['ja', 'en']),
    title: z.string(),
    description: z.string(),
    publishedAt: z.date(),
    updatedAt: z.date().optional(),
    tags: z.array(tag).default([]),
    draft: z.boolean().default(false),
    origin,
    license: z.string().default('CC-BY-4.0'),
  }),
});

export const collections = { blog };
