import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deployRelease,
  promoteRelease,
  rollbackRelease,
} from './artifact-release.mjs';

const USAGE = `Usage:
  node scripts/release-manager.mjs deploy --root <absolute-path> --dist <directory> --source <full-40-hex-sha> [--retain <1-${100}>]
  node scripts/release-manager.mjs promote --root <absolute-path> --source <full-40-hex-sha> [--retain <1-${100}>]
  node scripts/release-manager.mjs rollback --root <absolute-path> --source <full-40-hex-sha> [--retain <1-${100}>]

The release root must be explicitly configured by the operator and must already exist.
This tool only manages local files; it does not contact remote services or invoke a shell.
`;

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--root', '--dist', '--source', '--retain'].includes(name)) {
      throw new Error(`Unknown or positional argument: ${name}`);
    }
    if (options.has(name)) {
      throw new Error(`Option may only be specified once: ${name}`);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`Option requires a value: ${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Required option is missing: ${name}`);
  }
  return value;
}

function validateRoot(value) {
  if (!isAbsolute(value)) {
    throw new Error('--root must be an explicit absolute path.');
  }
  return resolve(value);
}

function parseRetention(options) {
  const rawValue = options.get('--retain');
  if (rawValue === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(rawValue)) {
    throw new Error('--retain must be an integer from 1 through 100.');
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > 100) {
    throw new Error('--retain must be an integer from 1 through 100.');
  }
  return value;
}

async function run(args) {
  const [command, ...optionArgs] = args;
  if (!['deploy', 'promote', 'rollback'].includes(command)) {
    throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  }

  const options = parseOptions(optionArgs);
  const allowed = command === 'deploy'
    ? new Set(['--root', '--dist', '--source', '--retain'])
    : new Set(['--root', '--source', '--retain']);
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Option is not valid for ${command}: ${name}`);
    }
  }

  const root = validateRoot(required(options, '--root'));
  const sourceCommit = required(options, '--source');
  const retain = parseRetention(options);
  let result;

  if (command === 'deploy') {
    const distDirectory = resolve(required(options, '--dist'));
    result = await deployRelease({ root, distDirectory, sourceCommit, retain });
  } else if (command === 'promote') {
    result = await promoteRelease({ root, sourceCommit, retain });
  } else {
    result = await rollbackRelease({ root, sourceCommit, retain });
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 1;
  });
}
