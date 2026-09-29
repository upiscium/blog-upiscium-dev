import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

const canonicalSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const canonicalTagIdentityPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const encodedTagIdentityPattern = /^tag-[0-9a-f]+$/;

function isProductionBuild(): boolean {
  return typeof import.meta.env !== 'undefined' && import.meta.env.PROD;
}

function validateTagDisplay(tag: string): string {
  if (!tag.trim()) {
    throw new Error('Blog tags must not be empty or whitespace.');
  }

  return tag;
}

function getEncodedTagIdentity(tag: string): string {
  const normalizedTag = tag.trim().normalize('NFC');
  const bytes = new TextEncoder().encode(normalizedTag);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `tag-${encoded}`;
}

/**
 * Convert a display label into the stable URL identity used by tag routes.
 *
 * Existing canonical labels retain their readable route identities. All other labels use
 * the UTF-8 hex encoding of their NFC-normalized form, which is URL-safe and injective for
 * normalized labels. Display labels are deliberately not rewritten: punctuation, whitespace,
 * case, and non-ASCII characters remain visible to readers. Labels that normalize to the same
 * key are rejected by assertUniqueTagIdentities instead of being silently merged into one route.
 */
export function getTagIdentity(tag: string): string {
  const displayTag = validateTagDisplay(tag);
  const normalizedTag = displayTag.trim().normalize('NFC');
  const keepsCanonicalIdentity =
    canonicalTagIdentityPattern.test(normalizedTag) &&
    !encodedTagIdentityPattern.test(normalizedTag);
  const routeIdentity = keepsCanonicalIdentity
    ? normalizedTag
    : getEncodedTagIdentity(normalizedTag);

  if (!canonicalTagIdentityPattern.test(routeIdentity)) {
    throw new Error(`Invalid blog tag identity "${routeIdentity}" for "${tag}".`);
  }

  return routeIdentity;
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

/**
 * Ensure every distinct display label has a distinct route identity.
 *
 * Encoded identities preserve labels that would otherwise lose information (for example,
 * `C++` and `C#`). Failing before route generation also protects against a collision caused
 * by normalization or a future identity-algorithm change.
 */
export function assertUniqueTagIdentities(tags: readonly string[]): void {
  const tagsByIdentity = new Map<string, string>();

  for (const tag of tags) {
    const displayTag = validateTagDisplay(tag);
    const identity = getTagIdentity(displayTag);
    const existingTag = tagsByIdentity.get(identity);

    if (existingTag && existingTag !== displayTag) {
      throw new Error(
        `Tag identity collision for "${identity}": "${existingTag}" and "${displayTag}".`,
      );
    }

    tagsByIdentity.set(identity, displayTag);
  }
}

export interface TagEntry {
  display: string;
  identity: string;
  path: string;
}

/**
 * Return deterministic display/identity/path tuples for a tag collection.
 * The collision assertion runs before any entries are returned so callers cannot
 * accidentally generate a partial taxonomy.
 */
export function getTagEntries(tags: readonly string[]): TagEntry[] {
  const uniqueTags = [...new Set(tags.map((tag) => validateTagDisplay(tag)))];
  assertUniqueTagIdentities(uniqueTags);

  return uniqueTags
    .map((display) => {
      const identity = getTagIdentity(display);

      return {
        display,
        identity,
        path: `/blog/tags/${identity}/`,
      };
    })
    .sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
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
  assertUniqueTagIdentities(posts.flatMap((post) => post.data.tags));

  const includeDrafts = options.includeDrafts ?? !isProductionBuild();
  return includeDrafts ? [...posts] : posts.filter((post) => !post.data.draft);
}

export function isDevelopmentDraft(post: BlogPost): boolean {
  return post.data.draft && !isProductionBuild();
}

export function getPublishedPosts(posts: readonly BlogPost[]): BlogPost[] {
  return getVisiblePosts(posts, { includeDrafts: false });
}

export function sortPostsByPublishedAt(posts: readonly BlogPost[]): BlogPost[] {
  assertUniqueEffectiveSlugs(posts);

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
  return getTagEntries(posts.flatMap((post) => post.data.tags)).map((entry) => entry.display);
}

export function getPostsByTag(posts: readonly BlogPost[], tag: string): BlogPost[] {
  const displayTag = validateTagDisplay(tag);
  assertUniqueEffectiveSlugs(posts);
  assertUniqueTagIdentities(posts.flatMap((post) => post.data.tags));

  return sortPostsByPublishedAt(
    posts.filter((post) =>
      post.data.tags.some((postTag: string) => postTag === displayTag),
    ),
  );
}

export function getTagPath(tag: string): string {
  return `/blog/tags/${getTagIdentity(tag)}/`;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
