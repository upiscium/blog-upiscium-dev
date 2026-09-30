# blog-upiscium-dev

CLI/terminal-inspired portfolio site built with Astro.

## Getting Started

```bash
pnpm install
pnpm dev --host 0.0.0.0
```

Open `http://localhost:4321` in your browser.

## Content

- Blog posts live in `src/content/blog/*.md`
- Blog routes are generated from Astro Content Collections
- Draft posts can be hidden with `draft: true`

## Markdown

Markdown posts support GitHub-flavored Markdown via `remark-gfm`.

Supported examples:

- headings
- lists and task lists
- blockquotes
- tables
- code blocks
- inline code
- links

Qiita-compatible notes use `:::note`, with optional `info`, `warn`, or
`alert` types. Notes are rendered as semantic, visibly distinct `<aside>`
containers and retain normal Markdown inside them. Unknown, malformed, or
nested note containers stop the build with an explicit diagnostic rather than
being silently rendered as ordinary text. Code fences may use
`language:filename`; the filename is emitted as escaped text without client
JavaScript.

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
```
