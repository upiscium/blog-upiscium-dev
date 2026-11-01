import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SCHEMA_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FILE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_RETENTION = 5;
const MAX_RETENTION = 100;
const RELEASES_DIRECTORY = 'releases';
const MANIFEST_FILENAME = 'manifest.json';

function fail(message) {
  throw new Error(message);
}

function normalizeSourceCommit(sourceCommit) {
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/iu.test(sourceCommit)) {
    fail('Source commit must be a full 40-character hexadecimal SHA.');
  }

  return sourceCommit.toLowerCase();
}

function assertSafeManifestPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    /^[a-z]:/iu.test(filePath) ||
    filePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`Unsafe artifact path: ${JSON.stringify(filePath)}.`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalManifestPayload(sourceCommit, files) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sourceCommit,
    files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  });
}

function canonicalManifest(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceCommit: manifest.sourceCommit,
    files: manifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    aggregateSha256: manifest.aggregateSha256,
  });
}

function aggregateFor(sourceCommit, files) {
  return createHash('sha256')
    .update('blog-artifact-manifest-v1\0', 'utf8')
    .update(canonicalManifestPayload(sourceCommit, files), 'utf8')
    .digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object.`);
  }

  const actual = Object.keys(value).sort(compareStrings);
  const required = [...expected].sort(compareStrings);
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${label} has an invalid set of fields.`);
  }
}

function validateManifestShape(manifest) {
  assertExactKeys(
    manifest,
    ['schemaVersion', 'sourceCommit', 'files', 'aggregateSha256'],
    'Manifest',
  );

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail(`Unsupported manifest schema version: ${String(manifest.schemaVersion)}.`);
  }
  if (typeof manifest.sourceCommit !== 'string' || !SHA_PATTERN.test(manifest.sourceCommit)) {
    fail('Manifest sourceCommit must be a lowercase full 40-character hexadecimal SHA.');
  }
  if (!Array.isArray(manifest.files)) {
    fail('Manifest files must be an array.');
  }
  if (typeof manifest.aggregateSha256 !== 'string' || !FILE_HASH_PATTERN.test(manifest.aggregateSha256)) {
    fail('Manifest aggregateSha256 must be a lowercase SHA-256 digest.');
  }

  let previousPath;
  for (const [index, file] of manifest.files.entries()) {
    assertExactKeys(file, ['path', 'size', 'sha256'], `Manifest file entry ${index}`);
    assertSafeManifestPath(file.path);
    if (previousPath !== undefined && compareStrings(previousPath, file.path) >= 0) {
      fail('Manifest file paths must be unique and sorted in ascending order.');
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      fail(`Manifest size must be a non-negative safe integer for ${JSON.stringify(file.path)}.`);
    }
    if (typeof file.sha256 !== 'string' || !FILE_HASH_PATTERN.test(file.sha256)) {
      fail(`Manifest SHA-256 is invalid for ${JSON.stringify(file.path)}.`);
    }
    previousPath = file.path;
  }

  const expectedAggregate = aggregateFor(manifest.sourceCommit, manifest.files);
  if (manifest.aggregateSha256 !== expectedAggregate) {
    fail('Manifest aggregate integrity check failed.');
  }
}

async function assertRealDirectory(directory, label) {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`${label} does not exist: ${directory}`);
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink or other file: ${directory}`);
  }
  return stat;
}

async function readRegularFile(filePath, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail(`${label} must not be a symlink: ${filePath}`);
    }
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      fail(`${label} must be a regular file: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size
    ) {
      fail(`${label} changed while being read: ${filePath}`);
    }
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

async function scanArtifact(artifactDirectory) {
  const artifactRoot = resolve(artifactDirectory);
  await assertRealDirectory(artifactRoot, 'Artifact directory');
  const files = [];

  async function visit(directory, relativeDirectory) {
    const before = await assertRealDirectory(directory, 'Artifact directory');
    const entries = await readdir(directory);
    entries.sort(compareStrings);

    for (const entryName of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entryName}` : entryName;
      assertSafeManifestPath(relativePath);
      const absolutePath = join(directory, entryName);
      const stat = await lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        fail(`Artifact contains a symlink: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        fail(`Artifact contains a non-regular file: ${relativePath}`);
      }

      const { bytes, stat: openedStat } = await readRegularFile(absolutePath, 'Artifact file');
      if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
        fail(`Artifact file changed while being scanned: ${relativePath}`);
      }
      files.push({
        path: relativePath,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }

    const after = await assertRealDirectory(directory, 'Artifact directory');
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail(`Artifact directory changed while being scanned: ${directory}`);
    }
  }

  await visit(artifactRoot, '');
  files.sort((left, right) => compareStrings(left.path, right.path));
  return files;
}

/** Generate a deterministic manifest bound to one complete source commit SHA. */
export async function createManifest({ distDirectory, sourceCommit }) {
  const normalizedCommit = normalizeSourceCommit(sourceCommit);
  const files = await scanArtifact(distDirectory);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    sourceCommit: normalizedCommit,
    files,
    aggregateSha256: aggregateFor(normalizedCommit, files),
  };
  await validateManifest({ distDirectory, manifest });
  return manifest;
}

/** Validate manifest structure, aggregate integrity, and the exact artifact tree. */
export async function validateManifest({ distDirectory, manifest }) {
  validateManifestShape(manifest);
  const actualFiles = await scanArtifact(distDirectory);
  if (actualFiles.length !== manifest.files.length) {
    fail(
      `Artifact file set differs from manifest (expected ${manifest.files.length}, found ${actualFiles.length}).`,
    );
  }

  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = actualFiles[index];
    if (expected.path !== actual.path) {
      fail(`Artifact path set differs from manifest at ${JSON.stringify(expected.path)}.`);
    }
    if (expected.size !== actual.size) {
      fail(`Artifact size mismatch for ${JSON.stringify(expected.path)}.`);
    }
    if (expected.sha256 !== actual.sha256) {
      fail(`Artifact SHA-256 mismatch for ${JSON.stringify(expected.path)}.`);
    }
  }

  return true;
}

function requireRootPath(root) {
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
    fail('Release root must be an explicit absolute path.');
  }
  return resolve(root);
}

function requirePosixNonRootCaller() {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    fail('Release operations require a POSIX non-root caller.');
  }

  const uid = process.getuid();
  const effectiveUid = process.geteuid();
  if (uid === 0 || effectiveUid === 0) {
    fail('Release operations must not run as root.');
  }

  return effectiveUid;
}

function isRealDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function assertSafeReleaseRootPath(normalizedRoot) {
  if (dirname(normalizedRoot) === normalizedRoot) {
    fail('Release root must not be the filesystem root.');
  }

  const callerUid = requirePosixNonRootCaller();
  const components = normalizedRoot.split('/').filter(Boolean);
  let componentPath = '/';

  for (const [index, component] of components.entries()) {
    componentPath = join(componentPath, component);
    const stat = await assertRealDirectory(componentPath, 'Release root path component');
    const isReleaseRoot = index === components.length - 1;

    if (isReleaseRoot) {
      if (stat.uid !== callerUid) {
        fail(`Release root must be owned by the caller: ${normalizedRoot}`);
      }
      if ((stat.mode & 0o022) !== 0) {
        fail(`Release root must not be group- or world-writable: ${normalizedRoot}`);
      }
      continue;
    }

    const ownerWritableByUntrusted =
      (stat.mode & 0o200) !== 0 && stat.uid !== 0 && stat.uid !== callerUid;
    if ((stat.mode & 0o022) !== 0) {
      const stickySharedDirectory =
        (stat.mode & 0o1000) !== 0 && (stat.uid === 0 || stat.uid === callerUid);
      if (!stickySharedDirectory) {
        fail(`Release root path has an untrusted writable ancestor: ${componentPath}`);
      }
    } else if (ownerWritableByUntrusted) {
      fail(`Release root path has an untrusted writable ancestor: ${componentPath}`);
    }
  }
}

function retentionLimit(retain = DEFAULT_RETENTION) {
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > MAX_RETENTION) {
    fail(`Retention must be an integer from 1 through ${MAX_RETENTION}.`);
  }
  return retain;
}

async function assertReleaseRoot(root) {
  const normalizedRoot = requireRootPath(root);
  await assertSafeReleaseRootPath(normalizedRoot);
  return normalizedRoot;
}

async function assertReleasesDirectory(root, { allowMissing = false } = {}) {
  const releasesDirectory = join(root, RELEASES_DIRECTORY);
  let stat;
  try {
    stat = await lstat(releasesDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) {
      return null;
    }
    if (error?.code === 'ENOENT') {
      fail(`Releases directory does not exist: ${releasesDirectory}`);
    }
    throw error;
  }

  if (!isRealDirectory(stat)) {
    fail(`Releases directory must be a real directory: ${releasesDirectory}`);
  }
  const callerUid = requirePosixNonRootCaller();
  if (stat.uid !== callerUid) {
    fail(`Releases directory must be owned by the caller: ${releasesDirectory}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    fail(`Releases directory must not be group- or world-writable: ${releasesDirectory}`);
  }

  return releasesDirectory;
}

async function ensureReleasesDirectory(root) {
  const releasesDirectory = join(root, RELEASES_DIRECTORY);
  try {
    await mkdir(releasesDirectory, { mode: 0o755 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
  return assertReleasesDirectory(root);
}

async function acquireLock(root) {
  await assertReleaseRoot(root);
  const lockPath = join(root, '.release-manager.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(`Release manager lock already exists; refusing concurrent or stale operation: ${lockPath}`);
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    await handle.close();
    await assertReleaseRoot(root)
      .then(() => unlink(lockPath))
      .catch(() => {});
    throw error;
  }

  return async () => {
    await assertReleaseRoot(root);
    await handle.close();
    await unlink(lockPath);
  };
}

async function withReleaseLock(root, operation) {
  const normalizedRoot = await assertReleaseRoot(root);
  const releaseLock = await acquireLock(normalizedRoot);
  try {
    await assertReleaseRoot(normalizedRoot);
    return await operation(normalizedRoot);
  } finally {
    await releaseLock();
  }
}

async function writeStagedArtifact(sourceDirectory, artifactDirectory, manifest) {
  await mkdir(artifactDirectory, { mode: 0o700 });

  for (const file of manifest.files) {
    const sourcePath = join(sourceDirectory, ...file.path.split('/'));
    const destinationPath = join(artifactDirectory, ...file.path.split('/'));
    const { bytes } = await readRegularFile(sourcePath, 'Artifact source file');
    if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      fail(`Artifact source changed after validation: ${JSON.stringify(file.path)}.`);
    }
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o444 });
  }

  await validateManifest({ distDirectory: artifactDirectory, manifest });
}

async function setTreeMode(directory, mode) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink()) {
    fail(`Refusing to change permissions through a symlink: ${directory}`);
  }
  if (stat.isDirectory()) {
    const children = await readdir(directory);
    for (const child of children) {
      await setTreeMode(join(directory, child), mode);
    }
    await chmod(directory, mode);
    return;
  }
  if (!stat.isFile()) {
    fail(`Release tree contains a non-regular file: ${directory}`);
  }
  await chmod(directory, mode === 0o555 ? 0o444 : mode);
}

async function assertReadOnlyTree(directory, label) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail(`${label} contains a symlink or non-regular entry: ${directory}`);
  }
  if ((stat.mode & 0o222) !== 0) {
    fail(`${label} is not immutable (write permission remains): ${directory}`);
  }
  if (stat.isDirectory()) {
    for (const child of await readdir(directory)) {
      await assertReadOnlyTree(join(directory, child), label);
    }
  }
}

async function removeOwnedStagingDirectory(root, stagingDirectory) {
  try {
    await assertReleasesDirectory(root);
    await setTreeMode(stagingDirectory, 0o700);
    await rm(stagingDirectory, { recursive: true, force: false });
  } catch {
    // Preserve the original staging error; the uniquely-created path is not a release.
  }
}

async function verifyRelease(root, sourceCommit) {
  const commit = normalizeSourceCommit(sourceCommit);
  const releasesDirectory = await assertReleasesDirectory(root);
  const releaseDirectory = join(releasesDirectory, commit);
  const releaseStat = await assertRealDirectory(releaseDirectory, 'Release directory');
  if ((releaseStat.mode & 0o222) !== 0) {
    fail(`Release directory is not immutable: ${releaseDirectory}`);
  }

  const entries = (await readdir(releaseDirectory)).sort(compareStrings);
  const expectedEntries = ['artifact', MANIFEST_FILENAME].sort(compareStrings);
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    fail(`Release contains unexpected entries: ${releaseDirectory}`);
  }

  const manifestPath = join(releaseDirectory, MANIFEST_FILENAME);
  const manifestInfo = await readRegularFile(manifestPath, 'Release manifest');
  if ((manifestInfo.stat.mode & 0o222) !== 0) {
    fail(`Release manifest is not immutable: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestInfo.bytes.toString('utf8'));
  } catch {
    fail(`Release manifest is not valid JSON: ${manifestPath}`);
  }
  validateManifestShape(manifest);
  if (manifest.sourceCommit !== commit) {
    fail(`Release manifest source commit does not match release directory ${commit}.`);
  }
  await validateManifest({ distDirectory: join(releaseDirectory, 'artifact'), manifest });
  await assertReadOnlyTree(join(releaseDirectory, 'artifact'), 'Release artifact');
  return { sourceCommit: commit, releaseDirectory, manifest };
}

async function stageReleaseUnlocked(root, { distDirectory, manifest }) {
  validateManifestShape(manifest);
  await validateManifest({ distDirectory, manifest });
  const releasesDirectory = await ensureReleasesDirectory(root);
  const finalDirectory = join(releasesDirectory, manifest.sourceCommit);

  let finalStat;
  try {
    finalStat = await lstat(finalDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (finalStat) {
    const existing = await verifyRelease(root, manifest.sourceCommit);
    if (canonicalManifest(existing.manifest) !== canonicalManifest(manifest)) {
      fail(`A different immutable release already exists for source commit ${manifest.sourceCommit}.`);
    }
    return { sourceCommit: manifest.sourceCommit, releaseDirectory: finalDirectory, alreadyPresent: true };
  }

  const stagingDirectory = await mkdtemp(join(releasesDirectory, `.staging-${manifest.sourceCommit}-`));
  try {
    const artifactDirectory = join(stagingDirectory, 'artifact');
    await writeStagedArtifact(resolve(distDirectory), artifactDirectory, manifest);
    const manifestPath = join(stagingDirectory, MANIFEST_FILENAME);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    await setTreeMode(artifactDirectory, 0o555);
    await chmod(manifestPath, 0o444);
    await chmod(stagingDirectory, 0o555);
    await rename(stagingDirectory, finalDirectory);
  } catch (error) {
    await removeOwnedStagingDirectory(root, stagingDirectory);
    throw error;
  }

  const release = await verifyRelease(root, manifest.sourceCommit);
  return { sourceCommit: manifest.sourceCommit, releaseDirectory: release.releaseDirectory, alreadyPresent: false };
}

/** Stage an immutable release and prune only validated inactive releases. */
export async function stageRelease({ root, distDirectory, manifest, retain = DEFAULT_RETENTION }) {
  return withReleaseLock(root, async (normalizedRoot) => {
    const normalizedManifest = manifest;
    const limit = retentionLimit(retain);
    validateManifestShape(normalizedManifest);
    await validateManifest({ distDirectory, manifest: normalizedManifest });
    const activeCommit = await readCurrentCommit(normalizedRoot);
    await listVerifiedReleases(normalizedRoot);
    if (activeCommit !== null && activeCommit !== normalizedManifest.sourceCommit && limit < 2) {
      fail('Retention must allow both the active release and the staged release.');
    }

    const staged = await stageReleaseUnlocked(normalizedRoot, {
      distDirectory: resolve(distDirectory),
      manifest: normalizedManifest,
    });
    const inventory = await listVerifiedReleases(normalizedRoot);
    const selection = selectRetainedReleases(
      inventory,
      activeCommit,
      limit,
      [normalizedManifest.sourceCommit],
    );
    const removed = await pruneReleases(normalizedRoot, selection.remove);
    return {
      ...staged,
      retained: [...selection.keep].sort(compareStrings),
      removed,
    };
  });
}

async function readCurrentCommit(root) {
  const currentPath = join(root, 'current');
  let stat;
  try {
    stat = await lstat(currentPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    fail(`Current release pointer must be a managed symlink: ${currentPath}`);
  }

  const target = await readlink(currentPath);
  const match = /^releases\/([0-9a-f]{40})\/artifact$/u.exec(target);
  if (!match) {
    fail(`Current release pointer has an unexpected target: ${target}`);
  }
  await verifyRelease(root, match[1]);
  return match[1];
}

async function replaceCurrent(root, sourceCommit) {
  const currentPath = join(root, 'current');
  const target = `${RELEASES_DIRECTORY}/${sourceCommit}/artifact`;
  const temporaryLink = join(root, `.current-${randomUUID()}`);
  await symlink(target, temporaryLink, 'dir');
  try {
    await rename(temporaryLink, currentPath);
  } catch (error) {
    await unlink(temporaryLink).catch(() => {});
    throw error;
  }
}

async function listVerifiedReleases(root) {
  const releasesDirectory = await assertReleasesDirectory(root, { allowMissing: true });
  if (releasesDirectory === null) {
    return [];
  }

  const entries = (await readdir(releasesDirectory)).sort(compareStrings);
  const releases = [];
  for (const entry of entries) {
    if (!SHA_PATTERN.test(entry)) {
      fail(`Unexpected entry in releases directory: ${entry}`);
    }
    const verified = await verifyRelease(root, entry);
    const stat = await lstat(verified.releaseDirectory, { bigint: true });
    releases.push({ ...verified, stagedAt: stat.mtimeNs });
  }
  return releases;
}

function selectRetainedReleases(releases, activeCommit, retain, additionallyKeep = []) {
  const ordered = [...releases].sort((left, right) => {
    if (left.stagedAt !== right.stagedAt) {
      return left.stagedAt > right.stagedAt ? -1 : 1;
    }
    return compareStrings(left.sourceCommit, right.sourceCommit);
  });
  const keep = new Set(additionallyKeep);
  if (activeCommit !== null) {
    keep.add(activeCommit);
  }
  if (keep.size > retain) {
    fail(`Retention limit ${retain} cannot preserve all active and requested releases.`);
  }
  for (const sourceCommit of keep) {
    if (!releases.some((release) => release.sourceCommit === sourceCommit)) {
      fail(`Required release is missing from the verified release inventory: ${sourceCommit}`);
    }
  }
  for (const release of ordered) {
    if (keep.size >= retain) {
      break;
    }
    keep.add(release.sourceCommit);
  }
  return { keep, remove: ordered.filter((release) => !keep.has(release.sourceCommit)) };
}

async function pruneReleases(root, releasesToRemove) {
  const removed = [];
  for (const release of releasesToRemove) {
    await assertReleasesDirectory(root);
    const activeCommit = await readCurrentCommit(root);
    if (activeCommit === release.sourceCommit) {
      fail(`Refusing to remove active release ${release.sourceCommit}.`);
    }
    await makeReleaseWritable(release.releaseDirectory);
    await rm(release.releaseDirectory, { recursive: true, force: false });
    removed.push(release.sourceCommit);
  }
  return removed;
}

async function makeReleaseWritable(releaseDirectory) {
  await setTreeMode(releaseDirectory, 0o700);
}

async function activateAndRetain(root, sourceCommit, retain) {
  const commit = normalizeSourceCommit(sourceCommit);
  const limit = retentionLimit(retain);
  await verifyRelease(root, commit);
  const previousCommit = await readCurrentCommit(root);
  const inventory = await listVerifiedReleases(root);
  const selection = selectRetainedReleases(inventory, commit, limit);

  await replaceCurrent(root, commit);
  const removed = await pruneReleases(root, selection.remove);

  return {
    sourceCommit: commit,
    previousCommit,
    currentPath: join(root, 'current'),
    releaseDirectory: join(root, RELEASES_DIRECTORY, commit),
    retained: [...selection.keep].sort(compareStrings),
    removed,
  };
}

/** Atomically promote an already staged, fully validated release and enforce retention. */
export async function promoteRelease({ root, sourceCommit, retain = DEFAULT_RETENTION }) {
  return withReleaseLock(root, (normalizedRoot) => activateAndRetain(normalizedRoot, sourceCommit, retain));
}

/** Roll back by atomically promoting the requested validated retained source commit. */
export async function rollbackRelease({ root, sourceCommit, retain = DEFAULT_RETENTION }) {
  return withReleaseLock(root, (normalizedRoot) => activateAndRetain(normalizedRoot, sourceCommit, retain));
}

/** Generate, validate, stage, atomically promote, then prune older inactive releases. */
export async function deployRelease({ root, distDirectory, sourceCommit, retain = DEFAULT_RETENTION }) {
  return withReleaseLock(root, async (normalizedRoot) => {
    retentionLimit(retain);
    const manifest = await createManifest({ distDirectory, sourceCommit });
    await stageReleaseUnlocked(normalizedRoot, {
      distDirectory: resolve(distDirectory),
      manifest,
    });
    return activateAndRetain(normalizedRoot, manifest.sourceCommit, retain);
  });
}

export const releaseManagerLimits = Object.freeze({
  defaultRetention: DEFAULT_RETENTION,
  maxRetention: MAX_RETENTION,
});
