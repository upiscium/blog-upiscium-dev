import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

const canonicalSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const canonicalTagPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeTag(tag: string): string {
  const normalizedTag = tag.trim();

  if (!normalizedTag) {
    throw new Error('Blog tags must not be empty or whitespace.');
  }

  if (!canonicalTagPattern.test(normalizedTag)) {
    throw new Error(`Invalid blog tag "${tag}"; tags must be lowercase URL path segments.`);
  }

  return normalizedTag;
}

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

export interface PostVisibilityOptions {
  /** Override the build environment when a caller needs deterministic behavior. */
  includeDrafts?: boolean;
}

/**
 * Return the posts that may be linked from the current build.
 *
 * Drafts are intentionally available during development so an author can
 * review an unpublished article locally. A production build remains safe by
 * default and excludes them from every generated listing and route.
 */
export function getVisiblePosts(
  posts: readonly BlogPost[],
  options: PostVisibilityOptions = {},
): BlogPost[] {
  assertUniqueEffectiveSlugs(posts);

  const includeDrafts = options.includeDrafts ?? !import.meta.env.PROD;
  return includeDrafts ? [...posts] : posts.filter((post) => !post.data.draft);
}

export function isDevelopmentDraft(post: BlogPost): boolean {
  return post.data.draft && !import.meta.env.PROD;
}

export function getPublishedPosts(posts: readonly BlogPost[]): BlogPost[] {
  return getVisiblePosts(posts, { includeDrafts: false });
}

export function sortPostsByPublishedAt(posts: readonly BlogPost[]): BlogPost[] {
  return [...posts].sort((a, b) => {
    const dateDifference = b.data.publishedAt.getTime() - a.data.publishedAt.getTime();

    if (dateDifference !== 0) {
      return dateDifference;
    }

    const aSlug = getEffectiveSlug(a);
    const bSlug = getEffectiveSlug(b);

    return aSlug < bSlug ? -1 : aSlug > bSlug ? 1 : 0;
  });
}

export function getOrderedPosts(
  posts: readonly BlogPost[],
  options: PostVisibilityOptions = {},
): BlogPost[] {
  return sortPostsByPublishedAt(getVisiblePosts(posts, options));
}

export function getPostPath(post: BlogPost): string {
  return `/blog/${getEffectiveSlug(post)}/`;
}

export function getAllTags(posts: readonly BlogPost[]): string[] {
  const tags = posts.flatMap((post) => post.data.tags.map((tag: string) => normalizeTag(tag)));

  return [...new Set(tags)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function getPostsByTag(posts: readonly BlogPost[], tag: string): BlogPost[] {
  const normalizedTag = normalizeTag(tag);

  return sortPostsByPublishedAt(
    posts.filter((post) =>
      post.data.tags.some((postTag: string) => normalizeTag(postTag) === normalizedTag),
    ),
  );
}

export function getTagPath(tag: string): string {
  return `/blog/tags/${encodeURIComponent(normalizeTag(tag))}/`;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
