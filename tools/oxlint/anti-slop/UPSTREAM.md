# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: d2a9aea3b896ffcb291a85f2c1301aa2543ad8c8 (skill folder tree `97962dc9fad565ca7695bf57805d9d0138ce1def`)
- Installed from: `install-anti-slop` skill (`skills/install-anti-slop/assets/anti-slop`), via skills.sh, 2026-11-06
- Installed path: `tools/oxlint/anti-slop/` (generic plugin `index.ts`; the bundled `effect/` plugin is not registered)
- Pristine at install: the copy matched the skill assets exactly.
- Dependencies: `oxlint` and `@oxlint/plugins` pinned at 1.91.0 (1.92.0 was blocked by Bun's minimum-release-age).
- Intentional deviations:
  - `shared/dictionary-types.ts`: `unsafeMembers[0]` → `(unsafeMembers[0] ?? null)` in the
    intersection branch, so it typechecks under this repo's `noUncheckedIndexedAccess`.
    Behavior is unchanged (guarded by `length > 0`).
