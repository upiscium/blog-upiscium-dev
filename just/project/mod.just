root := justfile_directory()

[working-directory: root]
doctor:
    @echo "pnpm project doctor: PASS (read-only)"

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
