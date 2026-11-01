# Self-hosted static-site deployment proposal

This document describes a proposed HTTP origin interface for `https://upiscium.dev`
behind the existing Nginx Proxy Manager (NPM). It is a source-level deployment
proposal, not a record of live infrastructure settings or an instruction to
perform a production cutover.

## Proposed request path

```text
Visitor -- HTTPS --> existing NPM -- HTTP --> static HTTP origin
                         TLS ends       operator-supplied host:port
                                          document root: <RELEASE_ROOT>/current
```

The public site is `https://upiscium.dev` (`astro.config.mjs` sets that site
URL), and Astro is configured for static output. The proposed NPM Proxy Host
interface is:

| Setting | Proposed value / status |
| --- | --- |
| Public hostname | `upiscium.dev` |
| TLS | Terminate HTTPS at the existing NPM; this is a proposed design, not a verified live setting. |
| Upstream scheme | HTTP from NPM to the origin; proposed only. Use only after the operator has verified that this hop uses a trusted network path. |
| Upstream host | `<ORIGIN_HOST>` — operator-supplied; no origin host or address is specified by the repository or Issue #28. |
| Upstream port | `<ORIGIN_PORT>` — operator-supplied; no origin port is specified by the repository or Issue #28. |
| Origin document root | `<RELEASE_ROOT>/current` — an operator-selected release root with the managed `current` symlink beneath it. |

These placeholders are not live values. The repository does not define an NPM
Proxy Host, static-server configuration, origin address, port, or network
topology. This proposal neither verifies nor changes any of them. The origin
serves static files; no Astro runtime server is specified for production.

## Artifact and release layout

`astro.config.mjs` sets `output: 'static'`, and `pnpm build` runs `astro build`,
which produces the `dist/` artifact. Issue #28 calls for an artifact tied to an
exact source commit. The release scripts bind a manifest to a full 40-character
commit SHA and record each artifact file's path, size, and SHA-256 plus an
aggregate SHA-256. They validate the complete file tree and reject symlinks and
unexpected entries.

### Exact-source local build procedure

For an exact-source operator procedure, set `SOURCE_SHA` to the intended full,
lowercase 40-hex commit SHA (not a branch, tag, or abbreviated SHA), then use a
detached checkout and confirm both the resolved commit and working tree before
building. This example assumes the source remote is named `origin`; use the
operator's verified repository checkout and remote.

```sh
export SOURCE_SHA='REPLACE_WITH_FULL_40_CHARACTER_SHA'

git fetch origin "$SOURCE_SHA"
git checkout --detach "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"

node --version   # Require v22.12.0 or newer.
pnpm --version   # Require pnpm 10.x.
pnpm install --frozen-lockfile
pnpm run build
test -z "$(git status --porcelain)"

node scripts/release-manager.mjs deploy \
  --root "$RELEASE_ROOT" \
  --dist dist \
  --source "$SOURCE_SHA"
```

Replace the example SHA before running the commands. `RELEASE_ROOT` must be set
to the operator-selected, already existing absolute release-root path, and the
release-manager command must run where both that path and `dist/` are locally
accessible. The release manager handles local files only; it does not transfer
the artifact or connect to a remote host. The source-remote name, repository
URL, release-root path, and any live origin address remain operator-supplied and
are not known here.

The `--source`/`sourceCommit` value is an operator declaration accepted by the
CLI. The CLI validates that it is a full SHA and records it in the manifest, but
does not inspect Git, prove that the checked-out tree has that SHA, or
independently prove that `dist/` was built from that commit. The procedure above
provides an operator-controlled checkout/build sequence, not cryptographic
build provenance. Per-file and aggregate hashes protect artifact integrity by
detecting content changes relative to the manifest; they do not prove source or
build provenance.

The local release manager stages each commit as an immutable, read-only release
and promotes it through a managed symlink. Its layout is:

```text
<RELEASE_ROOT>/
├── current -> releases/<full-40-character-commit-sha>/artifact
└── releases/
    └── <full-40-character-commit-sha>/
        ├── artifact/       # contents of the validated dist/
        └── manifest.json   # file inventory and integrity hashes
```

The `current` link is replaced by creating a temporary symlink and renaming it
over `current`, so the active release pointer changes atomically. Rollback
selects a previously retained, validated release in the same way; retention is
bounded (five releases by default in the script). The release manager operates
on local files only: it does not transfer an artifact, invoke a remote shell,
or configure the static server or NPM.

### Release-root constraints and access model

The release-manager code enforces these filesystem constraints: it must run as
a POSIX non-root caller; `--root` must be an explicit absolute path other than
the filesystem root; the root must already exist as a real directory, not a
symlink, and be owned by the calling user; and the root must not be
group-writable or world-writable. Path components must be real directories,
not symlinks. Untrusted writable ancestors are rejected; group/world-writable
ancestors are rejected except for a sticky shared directory owned by root or
the caller. The `releases/` directory is also required to be a real directory
owned by the caller with no group/world write permission. These checks are
enforced by the local release-manager code; they do not configure the host or
establish that any live filesystem has these properties.

Use a dedicated, non-root release-writer identity that owns a dedicated
`<RELEASE_ROOT>`. Do not share the writer identity with the static server. The
operator must provision a distinct, read-only static-server identity with the
directory-traverse and read access needed to follow `<RELEASE_ROOT>/current`,
and no write access to the root, release directories, artifacts, or the
`current` pointer. The HTTP document root points at `<RELEASE_ROOT>/current`,
limiting normal HTTP serving to the active release, but this is not a filesystem
isolation boundary. When creating `releases/`, the release manager requests mode
`0755`, subject to the invoking process's umask. Its checks reject group/world
write on that directory but do not guarantee read or traverse access for the
static-server identity. Release artifact directories are read-only and
traversable, and artifact files and manifests are read-only and readable.
Filesystem access to the releases tree can therefore include all retained
release trees under `releases/`, not just the active release. Keep only public
site content in release artifacts. Stricter isolation of inactive releases
would require a separate permission/deployment design outside this Task. Before
any separately authorized replacement test, the operator must provision and
verify that the selected server identity has read/traverse access through the
managed `current` symlink without write access. The identities, account
names/UIDs, group or ACL assignments, permissions, and actual release-root path
for any live deployment are unknown; the role names here are descriptive, not
configured account values.

## Static files and not-found responses

The site source includes `src/pages/404.astro`, which provides the site's
custom not-found page. For the static origin, serve the generated `404.html`
for unknown paths and return an HTTP 404 status rather than serving the page as
a successful response. The source defines the page content; the HTTP server's
fallback and status-code behavior is not configured or verified here and must
be checked during authorized replacement testing.

## Forwarded request information (proposed; live behavior unverified)

The following are recommendations for the NPM-to-origin boundary, not verified
NPM settings. The static site does not need forwarded headers to render its
files, but consistent forwarding is useful for origin access logs and any
future request handling:

- Preserve the public `Host` as `upiscium.dev`; where the proxy chain uses it,
  forward the original authority in `X-Forwarded-Host` as well.
- Set `X-Forwarded-Proto` to `https` to describe the visitor-facing scheme even
  though the proposed NPM-to-origin hop uses HTTP.
- Have the trusted proxy chain append the client address to
  `X-Forwarded-For`. The origin should treat forwarded client IPs as trustworthy
  only when supplied through the known NPM proxy path, and must not accept a
  client-provided forwarded value as authoritative.

The actual NPM header behavior and trust path are unknown. These semantics need
to be confirmed by the operator in any separately authorized configuration and
replacement test; this document does not assert that NPM currently applies them.

## Preservation and scope boundaries

- Keep existing NPM HTTPS, TCP, and UDP routing and Minecraft Streams intact.
- Do not add Cloudflare Tunnel or Caddy.
- Do not remove or disable the working Pages deployment until the replacement
  has been tested and explicitly approved. This document does not authorize
  changing the deployment workflow.
- DNS, NPM, router, server, workflow, credential, SSH, and infrastructure edits
  or operations are explicitly out of scope. No production access, deployment,
  or cutover is authorized by this proposal.
