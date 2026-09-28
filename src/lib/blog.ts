import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

const canonicalSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getEffectiveSlug(post: BlogPost): string {
  const slug = post.data.slug ?? post.id;

  if (!canonicalSlugPattern.test(slug)) {
    throw new Error(`Invalid effective blog slug "${slug}" for "${post.id}".`);
  }

  return slug;
}

export function assertUniqueEffectiveSlugs(posts: readonly BlogPost[]): void {
  const postsBySlug = new Map<string, BlogPost>();

  for (const post of posts) {
    const slug = getEffectiveSlug(post);
    const existingPost = postsBySlug.get(slug);

    if (existingPost) {
      throw new Error(
        `Duplicate effective blog slug "${slug}" for "${existingPost.id}" and "${post.id}".`,
      );
    }

    postsBySlug.set(slug, post);
  }
}

export function getPublishedPosts(posts: readonly BlogPost[]): BlogPost[] {
  assertUniqueEffectiveSlugs(posts);
  return posts.filter((post) => !post.data.draft);
}
