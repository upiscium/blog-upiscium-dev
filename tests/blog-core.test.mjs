import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertUniqueEffectiveSlugs,
  assertUniqueTagIdentities,
  getAllTags,
  getTagEntries,
  getTagIdentity,
  getTagPath,
  getPostsByTag,
  getVisiblePosts,
} from '../src/lib/blog.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const astroCli = join(projectRoot, 'node_modules', '.bin', 'astro');

function makePost(id, data = {}) {
  return {
    id,
    collection: 'blog',
    data: {
      slug: id,
      lang: 'en',
      title: id,
      description: `${id} description`,
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
      tags: [],
      draft: false,
      license: 'CC-BY-4.0',
      ...data,
    },
  };
}

function runAstro(args, cwd = projectRoot) {
  const result = spawnSync(astroCli, args, {
    cwd,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function createProjectFixture(prefix, setup = () => {}) {
  const fixtureRoot = mkdtempSync(join(projectRoot, `.blog-core-${prefix}-`));

  try {
    cpSync(join(projectRoot, 'src'), join(fixtureRoot, 'src'), { recursive: true });
    for (const file of ['astro.config.mjs', 'package.json', 'tsconfig.json']) {
      cpSync(join(projectRoot, file), join(fixtureRoot, file));
    }
    setup(fixtureRoot);
  } catch (error) {
    removeProjectFixture(fixtureRoot);
    throw error;
  }

  return fixtureRoot;
}

function removeProjectFixture(fixtureRoot) {
  assert.equal(dirname(fixtureRoot), projectRoot);
  assert.match(basename(fixtureRoot), /^\.blog-core-(?:content|build|metadata)-/);
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function createContentValidationFixture(originUrl) {
  return createProjectFixture('content', (fixtureRoot) => {
    writeFileSync(
      join(fixtureRoot, 'src/content/blog/origin-validation.md'),
      `---
slug: origin-validation
lang: en
title: Origin validation fixture
description: This fixture verifies origin URL validation.
publishedAt: 2026-04-11
tags: []
origin:
  platform: Example
  url: ${originUrl}
---

Validation fixture.
`,
    );
  });
}

function createBuildFixture() {
  const tag = '日本語 / 設計';
  const fixtureRoot = createProjectFixture('build', (fixtureRoot) => {
    writeFileSync(
      join(fixtureRoot, 'src/content/blog/published-unicode-origin.md'),
      `---
slug: published-unicode-origin
lang: en
title: Published Unicode Origin Fixture
description: This temporary fixture verifies published tag and origin rendering.
publishedAt: 2026-04-12
tags:
  - "${tag}"
origin:
  platform: Example Source
  url: https://example.com/published-origin
---

Published fixture content.
`,
    );
  });

  return { fixtureRoot, tag };
}

function createMetadataFixture() {
  const fixtureRoot = createProjectFixture('metadata', (fixtureRoot) => {
    writeFileSync(
      join(fixtureRoot, 'src/content/blog/draft-preview.md'),
      `---
slug: draft-preview
lang: en
title: Draft Navigation Fixture
description: A draft-only post used to verify production route exclusion.
publishedAt: 2026-04-09
tags:
  - draft-only
draft: true
origin:
  platform: Example
  url: https://example.com/draft-preview
---

This post is intentionally unpublished.
`,
    );
    writeFileSync(
      join(fixtureRoot, 'src/content/blog/updated-at-preview.md'),
      `---
slug: updated-at-preview
lang: en
title: Updated Metadata Fixture
description: A temporary article used to verify optional updatedAt rendering.
publishedAt: 2026-04-10
updatedAt: 2026-04-15
tags:
  - metadata
---

This article verifies published metadata rendering.
`,
    );
  });

  return fixtureRoot;
}

function readFixtureBuiltPage(fixtureRoot, relativePath) {
  return readFileSync(join(fixtureRoot, 'dist', relativePath), 'utf8');
}

function getRenderedCard(html, slug) {
  const start = html.indexOf(`href="/blog/${slug}/"`);
  assert.notEqual(start, -1, `missing rendered card for ${slug}`);

  const end = html.indexOf('</article>', start);
  assert.notEqual(end, -1, `missing closing article for ${slug}`);

  return html.slice(start, end);
}

async function getFreePort() {
  const probe = createServer();

  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });

  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  await new Promise((resolvePromise, rejectPromise) => {
    probe.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });

  return port;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForAstroDevServer(server, url, getSpawnError) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      throw spawnError;
    }

    if (server.exitCode !== null) {
      throw new Error(`Astro dev server exited with code ${server.exitCode}.`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Astro dev server returned ${response.status}: ${body}`);
      }
      return;
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for Astro dev server: ${errorMessage(lastError)}`);
}

async function stopAstroDevServer(server) {
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, delay(5_000)]);
  }

  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

async function startAstroDevServer(cwd = projectRoot) {
  const port = await getFreePort();
  const server = spawn(
    astroCli,
    ['dev', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let spawnError;

  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });
  server.once('error', (error) => {
    spawnError = error;
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForAstroDevServer(server, `${baseUrl}/`, () => spawnError);
  } catch (error) {
    await stopAstroDevServer(server);
    throw new Error(`${errorMessage(error)}\n${output}`);
  }

  return { server, baseUrl, output: () => output };
}

test('blog listing template renders language and optional updatedAt metadata', () => {
  const source = readFileSync(new URL('../src/pages/blog/index.astro', import.meta.url), 'utf8');

  assert.match(source, /<span class="meta-label">Language<\/span>/);
  assert.match(source, /\{post\.data\.lang\}/);
  assert.match(source, /post\.data\.updatedAt &&/);
  assert.match(source, /datetime=\{post\.data\.updatedAt\.toISOString\(\)\}/);
});

test('canonical blog content contains no test-only metadata fixtures', () => {
  assert.equal(existsSync(join(projectRoot, 'src/content/blog/draft-preview.md')), false);
  assert.doesNotMatch(
    readFileSync(join(projectRoot, 'src/content/blog/first-log.md'), 'utf8'),
    /^updatedAt:/m,
  );
});

test('visibility options cover production exclusion and development inclusion', () => {
  const published = makePost('published');
  const draft = makePost('draft', { draft: true });

  assert.deepEqual(
    getVisiblePosts([published, draft], { includeDrafts: false }),
    [published],
  );
  assert.deepEqual(
    getVisiblePosts([published, draft], { includeDrafts: true }),
    [published, draft],
  );
  assert.deepEqual(getVisiblePosts([published, draft]), [published, draft]);
});

test('tag entries preserve arbitrary display labels while generating safe paths', () => {
  const displayTags = ['C++', 'C#', 'NixOS', '設計 / UI', '日本語'];
  const entries = getTagEntries(displayTags);

  assert.deepEqual(
    entries.map((entry) => entry.display).sort(),
    [...displayTags].sort(),
  );
  assert.equal(getTagIdentity('C++'), 'tag-432b2b');
  assert.equal(getTagIdentity('C#'), 'tag-4323');
  assert.equal(getTagIdentity('NixOS'), 'tag-4e69784f53');
  assert.equal(getTagIdentity('日本語'), 'tag-e697a5e69cace8aa9e');
  assert.equal(getTagPath('C++'), '/blog/tags/tag-432b2b/');
  assert.equal(new Set(entries.map((entry) => entry.identity)).size, displayTags.length);
  assert.deepEqual(getTagEntries([...displayTags].reverse()), entries);
  assert.ok(entries.every((entry) => /^\/blog\/tags\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(entry.path)));
  assert.ok(entries.every((entry) => entry.path !== `/blog/tags/${entry.display}/`));
});

test('canonical-equivalent labels collide before route generation', () => {
  const composed = '\uac00';
  const decomposed = '\u1100\u1161';

  assert.equal(getTagIdentity(composed), 'tag-eab080');
  assert.equal(getTagIdentity(decomposed), 'tag-eab080');
  assert.throws(
    () => assertUniqueTagIdentities([composed, decomposed]),
    /Tag identity collision.*tag-eab080/,
  );
});

test('tag routes filter by the original display value', () => {
  const plusPlus = makePost('plus-plus', { tags: ['C++'] });
  const sharp = makePost('sharp', { tags: ['C#'] });
  const nixos = makePost('nixos', { tags: ['NixOS'] });
  const japanese = makePost('japanese', { tags: ['日本語'] });
  const routeSource = readFileSync(
    new URL('../src/pages/blog/tags/[tag].astro', import.meta.url),
    'utf8',
  );

  const posts = [plusPlus, sharp, nixos, japanese];
  assert.deepEqual(getAllTags(posts), ['C#', 'C++', 'NixOS', '日本語']);
  assert.deepEqual(getPostsByTag(posts, 'C++'), [plusPlus]);
  assert.deepEqual(getPostsByTag(posts, 'C#'), [sharp]);
  assert.deepEqual(getPostsByTag(posts, 'NixOS'), [nixos]);
  assert.deepEqual(getPostsByTag(posts, '日本語'), [japanese]);
  assert.match(routeSource, /params: \{ tag: identity \}/);
  assert.match(routeSource, /props: \{ tag: display, tagIdentity: identity/);
});

test('tag identity collisions fail closed before route generation', () => {
  assert.doesNotThrow(() => assertUniqueTagIdentities(['C++', 'C#', 'NixOS', '日本語']));
  assert.throws(
    () => getTagEntries(['a', ' a ']),
    /Tag identity collision.*a/,
  );
});

test('origin validation preserves http/https and rejects credentials and other protocols', () => {
  for (const originUrl of ['http://example.com/article', 'https://example.com/article']) {
    const fixtureRoot = createContentValidationFixture(originUrl);

    try {
      const result = runAstro(['check'], fixtureRoot);

      assert.equal(result.status, 0, commandOutput(result));
    } finally {
      removeProjectFixture(fixtureRoot);
    }
  }

  const invalidOrigins = [
    ['https://reader:secret@example.com/article', 'username or password'],
    ['ftp://example.com/article', 'http or https protocol'],
    ['javascript:alert(1)', 'http or https protocol'],
    ['data:text/plain,blocked', 'http or https protocol'],
  ];

  for (const [originUrl, expectedMessage] of invalidOrigins) {
    const fixtureRoot = createContentValidationFixture(originUrl);

    try {
      const result = runAstro(['check'], fixtureRoot);

      assert.notEqual(result.status, 0, commandOutput(result));
      assert.match(
        commandOutput(result),
        new RegExp(`Origin URL must (?:not include a |use the )${expectedMessage}`),
      );
    } finally {
      removeProjectFixture(fixtureRoot);
    }
  }
});

test('development server serves draft routes with visible markers', async () => {
  const fixtureRoot = createMetadataFixture();
  let server;

  try {
    const started = await startAstroDevServer(fixtureRoot);
    ({ server } = started);
    const { baseUrl, output } = started;
    const routes = [
      ['/', 'DRAFT · DEVELOPMENT', true],
      ['/blog/', 'DRAFT · DEVELOPMENT', true],
      ['/blog/draft-preview/', 'DRAFT · DEVELOPMENT ONLY', true],
      ['/blog/tags/draft-only/', 'DRAFT · DEVELOPMENT', true],
      ['/blog/tags/', 'DRAFT · DEVELOPMENT', false],
    ];

    for (const [route, marker, includesDraftTitle] of routes) {
      const response = await fetch(`${baseUrl}${route}`);
      const html = await response.text();

      assert.equal(response.status, 200, `${route}\n${output()}`);
      if (includesDraftTitle) {
        assert.ok(html.includes('Draft Navigation Fixture'), `missing draft title at ${route}`);
      }
      assert.ok(html.includes(marker), `missing visible draft marker at ${route}`);
      if (route === '/blog/') {
        assert.match(
          html,
          /<span class="meta-label"[^>]*>Updated<\/span>\s*<time[^>]*datetime="2026-04-15T00:00:00\.000Z"[^>]*>2026-04-15<\/time>/,
        );
      }
    }
  } finally {
    if (server) {
      await stopAstroDevServer(server);
    }
    removeProjectFixture(fixtureRoot);
  }
});

test('development tag index preserves draft tag identity, display, and count', async () => {
  const fixtureRoot = createMetadataFixture();
  let server;

  try {
    const started = await startAstroDevServer(fixtureRoot);
    ({ server } = started);
    const { baseUrl, output } = started;
    const response = await fetch(`${baseUrl}/blog/tags/`);
    const html = await response.text();

    assert.equal(response.status, 200, output());
    const draftTagStart = html.indexOf('href="/blog/tags/draft-only/"');
    assert.notEqual(draftTagStart, -1, 'missing draft-only tag identity');
    const draftTagEnd = html.indexOf('</li>', draftTagStart);
    assert.notEqual(draftTagEnd, -1, 'missing draft-only tag entry');
    const draftTagEntry = html.slice(draftTagStart, draftTagEnd);

    assert.match(draftTagEntry, />#draft-only<\/a>/);
    assert.match(draftTagEntry, /DRAFT · DEVELOPMENT/);
    assert.match(draftTagEntry, />1 posts<\/span>/);
  } finally {
    if (server) {
      await stopAstroDevServer(server);
    }
    removeProjectFixture(fixtureRoot);
  }
});

test('temporary production fixture builds arbitrary Unicode tags and published origins', () => {
  const { fixtureRoot, tag } = createBuildFixture();

  try {
    const result = runAstro(['build'], fixtureRoot);
    assert.equal(result.status, 0, commandOutput(result));

    const articlePath = join(fixtureRoot, 'dist', 'blog', 'published-unicode-origin', 'index.html');
    const tagIdentity = getTagIdentity(tag);
    const tagPath = join(fixtureRoot, 'dist', 'blog', 'tags', tagIdentity, 'index.html');
    assert.ok(existsSync(articlePath), 'published fixture article route was not generated');
    assert.ok(existsSync(tagPath), 'published arbitrary tag route was not generated');

    const articleHtml = readFixtureBuiltPage(fixtureRoot, 'blog/published-unicode-origin/index.html');
    const tagsIndex = readFixtureBuiltPage(fixtureRoot, 'blog/tags/index.html');
    const tagHtml = readFixtureBuiltPage(fixtureRoot, `blog/tags/${tagIdentity}/index.html`);

    assert.ok(tagsIndex.includes(`/blog/tags/${tagIdentity}/`));
    assert.ok(tagsIndex.includes(`#${tag}`));
    assert.ok(tagHtml.includes(`#${tag}`));
    assert.ok(tagHtml.includes('Published Unicode Origin Fixture'));
    assert.match(articleHtml, /href="https:\/\/example\.com\/published-origin"/);
    assert.match(articleHtml, />Example Source<\/a>/);
  } finally {
    removeProjectFixture(fixtureRoot);
  }
});

test('temporary production fixture renders metadata and excludes drafts from all routes', () => {
  const fixtureRoot = createMetadataFixture();

  try {
    const result = runAstro(['build'], fixtureRoot);
    assert.equal(result.status, 0, commandOutput(result));

    const home = readFixtureBuiltPage(fixtureRoot, 'index.html');
    const blogIndex = readFixtureBuiltPage(fixtureRoot, 'blog/index.html');
    const tagsIndex = readFixtureBuiltPage(fixtureRoot, 'blog/tags/index.html');
    const updatedAtCard = getRenderedCard(blogIndex, 'updated-at-preview');
    const terminalWorkflowCard = getRenderedCard(blogIndex, 'terminal-workflow');

    assert.match(updatedAtCard, /<span class="meta-label"[^>]*>Language<\/span>\s*en/);
    assert.match(
      updatedAtCard,
      /<span class="meta-label"[^>]*>Updated<\/span>\s*<time[^>]*datetime="2026-04-15T00:00:00\.000Z"[^>]*>2026-04-15<\/time>/,
    );
    assert.match(
      readFixtureBuiltPage(fixtureRoot, 'blog/updated-at-preview/index.html'),
      /<dt[^>]*>Updated<\/dt>\s*<dd[^>]*>\s*<time[^>]*datetime="2026-04-15T00:00:00\.000Z"[^>]*>2026-04-15<\/time>/,
    );
    assert.doesNotMatch(updatedAtCard, /DRAFT/);
    assert.doesNotMatch(terminalWorkflowCard, /Updated/);

    assert.doesNotMatch(blogIndex, /Draft Navigation Fixture/);
    assert.doesNotMatch(tagsIndex, /draft-only/);
    assert.doesNotMatch(tagsIndex, /DRAFT · DEVELOPMENT/);
    assert.doesNotMatch(home, /Draft Navigation Fixture/);
    assert.doesNotMatch(home, /DRAFT · DEVELOPMENT/);
    assert.ok(!existsSync(join(fixtureRoot, 'dist', 'blog', 'draft-preview', 'index.html')));
    assert.ok(!existsSync(join(fixtureRoot, 'dist', 'blog', 'tags', 'draft-only', 'index.html')));

    assert.ok(existsSync(join(fixtureRoot, 'dist', 'blog', 'tags', 'architecture', 'index.html')));
    assert.match(
      readFixtureBuiltPage(fixtureRoot, 'blog/tags/architecture/index.html'),
      /System Design Notes for Frontend/,
    );
  } finally {
    removeProjectFixture(fixtureRoot);
  }
});

test('duplicate effective slugs fail closed', () => {
  const first = makePost('first', { slug: 'same-slug' });
  const second = makePost('second', { slug: 'same-slug' });

  assert.throws(
    () => assertUniqueEffectiveSlugs([first, second]),
    /Duplicate effective blog slug "same-slug"/,
  );
  assert.throws(
    () => getVisiblePosts([first, second], { includeDrafts: false }),
    /Duplicate effective blog slug "same-slug"/,
  );
});
