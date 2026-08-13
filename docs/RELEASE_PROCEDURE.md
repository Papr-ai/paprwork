# Release Procedure

**Last updated:** 2026-08-13

How to ship a Paprwork desktop release without breaking auto-update.

---

## Root cause (v2.2.8, v2.3.0)

We had **two competing release paths**:

1. `electron-builder --publish always` on each platform job (uploads binaries + `latest-*.yml` to GitHub)
2. Final `softprops/action-gh-release` job (uploads binaries from artifacts **without** the yml files)

If you run `gh release create` **before** CI finishes, electron-builder skips publishing metadata (`existingType=release publishingType=draft`). The final job then uploads installers but **not** `latest-mac.yml` → Mac auto-update 404s.

---

## Correct procedure (always follow)

### 1. Bump version on `master`

```bash
# package.json + ui/package.json → "2.x.y"
# ui/components/Settings/SettingsView.tsx → What's New block for 2.x.y
git add package.json ui/package.json ui/components/Settings/SettingsView.tsx
git commit -m "Release v2.x.y: <short summary>"
git push origin master
```

### 2. Tag and push — **CI creates the release**

```bash
git tag v2.x.y
git push origin v2.x.y
```

**Do NOT run `gh release create` before the tag push.** CI owns release creation.

### 3. Wait for CI

Watch: **Actions → Release** (triggered by the tag).

The workflow now:
- Builds Mac/Windows/Linux with `--publish never` (local artifacts only)
- Collects `latest-mac.yml`, `latest.yml`, `latest-linux.yml` into artifacts
- **Rewrites `latest-mac.yml` URLs** to match actual `Papr.Work-*-mac.zip` files (`fix-latest-mac-yml.mjs`)
- **Fails the job** if yml URLs don't match zip artifacts on disk
- Creates/updates the GitHub release with all binaries + metadata in one step

### 4. Optional: edit release notes after CI

```bash
gh release edit v2.x.y --notes-file release-notes.md
```

### 5. Verify (optional sanity check)

```bash
npm run verify:release -- v2.x.y
```

---

## Never do this

| ❌ Don't | Why |
|----------|-----|
| `gh release create v2.x.y` before tag CI completes | Breaks electron-builder metadata upload; was the v2.3.0 bug |
| Skip the version bump commit | Tag builds wrong version |
| Manually upload only `.pkg`/`.exe` without yml | Auto-updater needs `latest-mac.yml` |
| Trust electron-builder yml URLs without verifying | yml may say `Papr-Work-*` while zips are `Papr.Work-*` → 404 |

---

## If metadata is still missing

Rare fallback (should not be needed after workflow fix):

```bash
# Download release zips, regenerate hashes, upload yml
# See v2.3.0 fix in agent transcript / manual upload with gh release upload
gh release upload v2.x.y latest-mac.yml latest.yml latest-linux.yml --clobber
```

---

## Checklist

- [ ] Version bumped in `package.json` + `ui/package.json`
- [ ] What's New added in Settings About tab
- [ ] Changes committed and pushed to `master`
- [ ] Tag pushed: `git push origin v2.x.y` (no `gh release create` first)
- [ ] Release workflow green
- [ ] `npm run verify:release -- v2.x.y` passes (optional)
