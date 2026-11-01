import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createManifest,
  deployRelease,
  promoteRelease,
  rollbackRelease,
  stageRelease,
  validateManifest,
} from '../scripts/artifact-release.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseCli = join(projectRoot, 'scripts', 'release-manager.mjs');
const isRootCaller =
  typeof process.getuid === 'function' &&
  typeof process.geteuid === 'function' &&
  (process.getuid() === 0 || process.geteuid() === 0);

function snapshotEntry(entryPath) {
  const stat = lstatSync(entryPath, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function createFixture() {
  const fixtureRoot = mkdtempSync(join(projectRoot, '.release-test-'));
  const root = join(fixtureRoot, 'release-root');
  const distDirectory = join(fixtureRoot, 'dist');
  mkdirSync(root);
  mkdirSync(distDirectory);

  return { fixtureRoot, root, distDirectory };
}

function removeFixture(fixtureRoot) {
  function makeWritable(entryPath) {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(entryPath)) {
        makeWritable(join(entryPath, child));
      }
      chmodSync(entryPath, 0o700);
      return;
    }
    chmodSync(entryPath, 0o600);
  }

  makeWritable(fixtureRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function putFile(distDirectory, relativePath, contents) {
  const filePath = join(distDirectory, ...relativePath.split('/'));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

async function withFixture(run) {
  const fixture = createFixture();
  try {
    await run(fixture);
  } finally {
    removeFixture(fixture.fixtureRoot);
  }
}

test('filesystem-root release paths are rejected before creating a lock', async () => {
  await assert.rejects(
    promoteRelease({ root: '/', sourceCommit: 'a'.repeat(40) }),
    /filesystem root/u,
  );
});

test(
  'root callers are rejected before creating a release lock',
  { skip: !isRootCaller },
  async () => {
    await withFixture(async ({ root }) => {
      await assert.rejects(
        promoteRelease({ root, sourceCommit: 'a'.repeat(40) }),
        /must not run as root/u,
      );
      assert.equal(snapshotEntry(join(root, '.release-manager.lock')), null);
    });
  },
);

test(
  'group/world-writable release roots are rejected before lock or release creation',
  { skip: isRootCaller },
  async () => {
    await withFixture(async ({ root, distDirectory }) => {
      putFile(distDirectory, 'index.html', 'unsafe root');
      const manifest = await createManifest({ distDirectory, sourceCommit: 'b'.repeat(40) });
      chmodSync(root, 0o777);

      try {
        await assert.rejects(
          stageRelease({ root, distDirectory, manifest }),
          /group- or world-writable/u,
        );
        assert.equal(snapshotEntry(join(root, '.release-manager.lock')), null);
        assert.equal(snapshotEntry(join(root, 'releases')), null);
      } finally {
        chmodSync(root, 0o700);
      }
    });
  },
);

test(
  'group/world-writable releases namespaces are rejected before traversal or staging',
  { skip: isRootCaller },
  async () => {
    await withFixture(async ({ root, distDirectory }) => {
      putFile(distDirectory, 'index.html', 'unsafe namespace');
      const manifest = await createManifest({ distDirectory, sourceCommit: 'c'.repeat(40) });
      const releasesDirectory = join(root, 'releases');
      mkdirSync(releasesDirectory);
      chmodSync(releasesDirectory, 0o777);
      const before = snapshotEntry(releasesDirectory);

      await assert.rejects(
        stageRelease({ root, distDirectory, manifest }),
        /group- or world-writable/u,
      );

      assert.equal(snapshotEntry(join(root, '.release-manager.lock')), null);
      assert.deepEqual(snapshotEntry(releasesDirectory), before);
      assert.deepEqual(readdirSync(releasesDirectory), []);
    });
  },
);

test('manifest binds a full source SHA and validates every path, type, size, digest, and aggregate', async () => {
  await withFixture(async ({ distDirectory }) => {
    putFile(distDirectory, 'index.html', '<h1>home</h1>');
    putFile(distDirectory, 'assets/site.css', 'body { color: black; }');

    const manifest = await createManifest({
      distDirectory,
      sourceCommit: 'A'.repeat(40),
    });

    assert.equal(manifest.sourceCommit, 'a'.repeat(40));
    assert.deepEqual(manifest.files.map((file) => file.path), ['assets/site.css', 'index.html']);
    assert.ok(manifest.files.every((file) => Number.isSafeInteger(file.size) && /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.match(manifest.aggregateSha256, /^[a-f0-9]{64}$/u);
    assert.equal(await validateManifest({ distDirectory, manifest }), true);

    writeFileSync(join(distDirectory, 'index.html'), '<h1>changed</h1>');
    await assert.rejects(validateManifest({ distDirectory, manifest }), /size mismatch|SHA-256 mismatch/u);

    const invalidAggregate = { ...manifest, aggregateSha256: '0'.repeat(64) };
    await assert.rejects(validateManifest({ distDirectory, manifest: invalidAggregate }), /aggregate integrity/u);

    const traversalManifest = {
      ...manifest,
      files: [{ ...manifest.files[0], path: '../outside' }],
    };
    await assert.rejects(validateManifest({ distDirectory, manifest: traversalManifest }), /Unsafe artifact path/u);
    await assert.rejects(
      createManifest({ distDirectory, sourceCommit: '1234' }),
      /full 40-character hexadecimal SHA/u,
    );
  });
});

test('manifest generation rejects symlinks and validation rejects unexpected artifact files', async () => {
  await withFixture(async ({ fixtureRoot, distDirectory }) => {
    putFile(distDirectory, 'index.html', 'safe');
    const manifest = await createManifest({ distDirectory, sourceCommit: '1'.repeat(40) });
    putFile(distDirectory, 'surprise.txt', 'not listed');
    await assert.rejects(validateManifest({ distDirectory, manifest }), /file set differs/u);

    rmSync(join(distDirectory, 'surprise.txt'));
    writeFileSync(join(fixtureRoot, 'outside.txt'), 'outside');
    symlinkSync(join(fixtureRoot, 'outside.txt'), join(distDirectory, 'linked.txt'));
    await assert.rejects(
      createManifest({ distDirectory, sourceCommit: '2'.repeat(40) }),
      /contains a symlink/u,
    );
  });
});

test('staging is immutable and idempotent for the same commit and manifest', async () => {
  await withFixture(async ({ root, distDirectory }) => {
    putFile(distDirectory, 'index.html', 'release one');
    const manifest = await createManifest({ distDirectory, sourceCommit: '3'.repeat(40) });

    const first = await stageRelease({ root, distDirectory, manifest });
    const repeated = await stageRelease({ root, distDirectory, manifest });

    assert.equal(first.alreadyPresent, false);
    assert.equal(repeated.alreadyPresent, true);
    assert.equal(readFileSync(join(first.releaseDirectory, 'artifact', 'index.html'), 'utf8'), 'release one');
    assert.equal(lstatSync(join(first.releaseDirectory, 'artifact', 'index.html')).mode & 0o222, 0);

    putFile(distDirectory, 'index.html', 'different content for same commit');
    const conflictingManifest = await createManifest({ distDirectory, sourceCommit: '3'.repeat(40) });
    await assert.rejects(
      stageRelease({ root, distDirectory, manifest: conflictingManifest }),
      /different immutable release/u,
    );
    assert.equal(readFileSync(join(first.releaseDirectory, 'artifact', 'index.html'), 'utf8'), 'release one');
  });
});

test('staging applies bounded retention without changing the current release', async () => {
  await withFixture(async ({ root, distDirectory }) => {
    const commits = ['a', 'b', 'c'].map((digit) => digit.repeat(40));
    for (const [index, sourceCommit] of commits.entries()) {
      putFile(distDirectory, 'index.html', `staged ${index + 1}`);
      const manifest = await createManifest({ distDirectory, sourceCommit });
      await stageRelease({ root, distDirectory, manifest, retain: 2 });
    }

    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), commits.slice(1).sort());
    assert.equal(lstatSync(join(root, 'current'), { throwIfNoEntry: false }), undefined);
  });
});

test('deploy promotes atomically, retains a bounded set, and rolls back only to a validated release', async () => {
  await withFixture(async ({ root, distDirectory }) => {
    const commits = ['4', '5', '6'].map((digit) => digit.repeat(40));
    const deploys = [];

    for (const [index, sourceCommit] of commits.entries()) {
      putFile(distDirectory, 'index.html', `release ${index + 1}`);
      deploys.push(await deployRelease({ root, distDirectory, sourceCommit, retain: 2 }));
    }

    assert.equal(readlinkSync(join(root, 'current')), `releases/${commits[2]}/artifact`);
    assert.equal(lstatSync(join(root, 'current')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(root, 'current', 'index.html'), 'utf8'), 'release 3');
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), commits.slice(1).sort());
    assert.deepEqual(deploys[2].retained, commits.slice(1).sort());
    assert.deepEqual(deploys[2].removed, [commits[0]]);

    const rolledBack = await rollbackRelease({ root, sourceCommit: commits[1], retain: 2 });
    assert.equal(rolledBack.previousCommit, commits[2]);
    assert.equal(readlinkSync(join(root, 'current')), `releases/${commits[1]}/artifact`);
    assert.equal(readFileSync(join(root, 'current', 'index.html'), 'utf8'), 'release 2');
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), commits.slice(1).sort());
    await assert.rejects(
      promoteRelease({ root, sourceCommit: commits[0], retain: 2 }),
      /Release directory does not exist/u,
    );
  });
});

test('rollback fails closed when a retained release no longer matches its manifest', async () => {
  await withFixture(async ({ root, distDirectory }) => {
    const olderCommit = '8'.repeat(40);
    const activeCommit = '9'.repeat(40);
    putFile(distDirectory, 'index.html', 'older release');
    await deployRelease({ root, distDirectory, sourceCommit: olderCommit, retain: 2 });
    putFile(distDirectory, 'index.html', 'current release');
    await deployRelease({ root, distDirectory, sourceCommit: activeCommit, retain: 2 });

    const tamperedFile = join(root, 'releases', olderCommit, 'artifact', 'index.html');
    chmodSync(tamperedFile, 0o644);
    writeFileSync(tamperedFile, 'tampered retained release');
    await assert.rejects(
      rollbackRelease({ root, sourceCommit: olderCommit, retain: 2 }),
      /size mismatch|SHA-256 mismatch/u,
    );
    assert.equal(readlinkSync(join(root, 'current')), `releases/${activeCommit}/artifact`);
    assert.equal(readFileSync(join(root, 'current', 'index.html'), 'utf8'), 'current release');
  });
});

test('promotion refuses an unmanaged current path and the CLI requires an explicit root', async () => {
  await withFixture(async ({ root, distDirectory }) => {
    putFile(distDirectory, 'index.html', 'content');
    const manifest = await createManifest({ distDirectory, sourceCommit: '7'.repeat(40) });
    await stageRelease({ root, distDirectory, manifest });
    writeFileSync(join(root, 'current'), 'operator file');

    await assert.rejects(
      promoteRelease({ root, sourceCommit: manifest.sourceCommit }),
      /must be a managed symlink/u,
    );
    assert.equal(readFileSync(join(root, 'current'), 'utf8'), 'operator file');

    const cli = spawnSync(process.execPath, [releaseCli, 'deploy', '--dist', distDirectory, '--source', '7'.repeat(40)], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /Required option is missing: --root/u);
  });
});

test(
  'release-manager CLI deploys successfully and reports the active release',
  { skip: isRootCaller },
  async () => {
    await withFixture(async ({ root, distDirectory }) => {
      const sourceCommit = 'd'.repeat(40);
      putFile(distDirectory, 'index.html', 'CLI deployment');

      const cli = spawnSync(
        process.execPath,
        [
          releaseCli,
          'deploy',
          '--root',
          root,
          '--dist',
          distDirectory,
          '--source',
          sourceCommit,
        ],
        {
          cwd: projectRoot,
          encoding: 'utf8',
        },
      );

      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stderr, '');
      const result = JSON.parse(cli.stdout);
      assert.equal(result.sourceCommit, sourceCommit);
      assert.equal(result.previousCommit, null);
      assert.equal(result.currentPath, join(root, 'current'));
      assert.equal(result.releaseDirectory, join(root, 'releases', sourceCommit));
      assert.deepEqual(result.retained, [sourceCommit]);
      assert.deepEqual(result.removed, []);
      assert.equal(readlinkSync(join(root, 'current')), `releases/${sourceCommit}/artifact`);
      assert.equal(lstatSync(join(root, 'current')).isSymbolicLink(), true);
      assert.equal(readFileSync(join(root, 'current', 'index.html'), 'utf8'), 'CLI deployment');
    });
  },
);
