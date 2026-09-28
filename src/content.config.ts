import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be a lowercase URL path segment.')
  .optional();

const origin = z
  .object({
    platform: z.string(),
    url: z.url(),
  })
  .optional();

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    slug,
    lang: z.enum(['ja', 'en']),
    title: z.string(),
    description: z.string(),
    publishedAt: z.date(),
    updatedAt: z.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    origin,
    license: z.string().default('CC-BY-4.0'),
  }),
});

export const collections = { blog };
