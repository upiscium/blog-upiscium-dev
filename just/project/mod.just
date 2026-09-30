root := justfile_directory()

[working-directory: root]
doctor:
    #!/usr/bin/env bash
    set -euo pipefail

    fail() {
        printf 'pnpm project doctor: FAIL: %s\n' "$*" >&2
        exit 1
    }

    if ! node_path="$(command -v node 2>/dev/null)"; then
        fail "Node executable not found"
    fi
    if [[ ! -f "$node_path" || ! -x "$node_path" ]]; then
        fail "Node is not executable: $node_path"
    fi
    if ! node_version="$("$node_path" --version 2>&1)"; then
        fail "Node version check failed: $node_version"
    fi
    if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        fail "Node reported invalid version: $node_version"
    fi
    node_major="${BASH_REMATCH[1]}"
    node_minor="${BASH_REMATCH[2]}"
    if (( node_major < 22 || (node_major == 22 && node_minor < 12) )); then
        fail "Node >=22.12.0 required (found $node_version)"
    fi

    if ! pnpm_path="$(command -v pnpm 2>/dev/null)"; then
        fail "pnpm executable not found"
    fi
    if [[ ! -f "$pnpm_path" || ! -x "$pnpm_path" ]]; then
        fail "pnpm is not executable: $pnpm_path"
    fi

    for required_file in package.json pnpm-lock.yaml; do
        if [[ ! -f "$required_file" ]]; then
            fail "required root file missing: $required_file"
        fi
    done

    for competing_lockfile in package-lock.json npm-shrinkwrap.json yarn.lock bun.lock bun.lockb; do
        if [[ -e "$competing_lockfile" || -L "$competing_lockfile" ]]; then
            fail "competing root lockfile present: $competing_lockfile"
        fi
    done

    printf '%s\n' 'pnpm project doctor: PASS (read-only)'

[working-directory: root]
format-check:
    @echo "pnpm format-check: SKIPPED (no package.json script)"

[working-directory: root]
lint:
    @echo "pnpm lint: SKIPPED (no package.json script)"

[working-directory: root]
test:
    pnpm run test

[working-directory: root]
build:
    pnpm run build

[working-directory: root]
check: doctor format-check lint test build
    pnpm run check
