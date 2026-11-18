# Karbon Atlas git workflow

This repository (`lakksithhariie-karbon/karbon-atlas`) is a standalone copy of
[cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) with its full git history, so
upstream changes merge in cleanly. It is not a GitHub fork. ("Fork" in this file's name means a
downstream copy.)

This file holds Karbon Atlas's git and GitHub rules. `AGENTS.md` holds upstream's code rules, which
still apply. Every agent (Claude Code, Cursor, Factory Droid) and every person follows both.

## Remotes

| Remote | URL | Use |
|---|---|---|
| `origin` | `https://github.com/lakksithhariie-karbon/karbon-atlas` | Karbon Atlas. All pushes go here. |
| `upstream` | `https://github.com/cloudflare/cloudflare-os` | Official repo. Fetch only; push URL is disabled. |

- Local `main` tracks `origin/main`.
- Git reads the GitHub token from `.secrets/.env` (`GH_TOKEN=...`) through a repo-local credential helper. The file is git-ignored by the existing `.env` rule. Never print, commit or copy the token.
- Do not put secrets in a root `.env`: Wrangler loads it into the dev-router worker's environment. Use `.dev.vars` for app secrets and `.secrets/.env` for GitHub.

New clone setup:

```sh
git clone https://github.com/lakksithhariie-karbon/karbon-atlas.git && cd karbon-atlas
git remote add upstream https://github.com/cloudflare/cloudflare-os
git remote set-url --push upstream DISABLED-read-only-upstream
```

## Branches

| Branch | Owner | Rule |
|---|---|---|
| `main` | Changes land only through PRs (see "Who merges") | Protected: PR required (admins included), no force push, no deletion |
| `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>` | Whoever does the work | One topic per branch, branched from up-to-date `main` |
| `upstream-sync` | `upstream-sync.yml` workflow | Bot-owned mirror of `upstream/main`. Never commit to it. |

## Making a change

```sh
git switch main && git pull --ff-only
git switch -c feat/<topic>
# ... edit, then run the checks AGENTS.md requires (pnpm lint / tests for what you touched)
git add <files> && git commit
git push -u origin feat/<topic>
```

Then open a PR **into `lakksithhariie-karbon/karbon-atlas:main`**. With `gh`:
`gh pr create --repo lakksithhariie-karbon/karbon-atlas --base main`. Without it, use the link
`git push` prints.

Rules:
- Never commit to `main`, never force-push `main` or `upstream-sync`.
- Never run `git reset --hard`, `git clean`, `git checkout -- .` or `git stash drop` over someone's uncommitted work. Check `git status` first.
- Leave upstream-owned files untouched where possible. Put Karbon-only code and docs in new files, so upstream merges stay free of conflicts.
- Do not change `workshop-backend` / `workshop-shared` architecture for product work without an explicit request (see "The kernel" in `AGENTS.md`).
- Merges use **merge commits**. Squash and rebase merges are disabled on the repo because they break upstream syncs.

## Receiving upstream updates

Upstream changes never arrive on their own. They arrive as a pull request that someone reviews and merges by hand (see "Who merges").

### Automatic proposal (weekly)

`.github/workflows/upstream-sync.yml` runs every Monday at 06:17 UTC, and on demand from the Actions tab:

1. Fetches `upstream/main`.
2. If `main` is behind, fast-forwards the `upstream-sync` branch to `upstream/main` (never force-pushes).
3. Opens or updates **one** PR `upstream-sync → main` with the commit list and the sensitive paths touched (`.github/`, Worker configs, `scripts/release/`, lockfile, workspace config).

It never merges, never enables auto-merge and never deploys.

Token: add a repo secret `UPSTREAM_SYNC_TOKEN`: a fine-grained PAT for this repo only, with Contents,
Pull requests and Workflows set to read and write. Without it the workflow falls back to
`GITHUB_TOKEN`, which fails in any week where upstream edits a workflow file, and whose PRs do not trigger CI.

### Reviewing a sync PR

1. Read the "Sensitive paths touched" list. A new or changed file under `.github/workflows/` becomes active in Karbon Atlas when merged, so check its triggers and secrets.
2. Wait for CI. If it did not start, close and reopen the PR.
3. Test locally:
   ```sh
   git fetch origin upstream-sync
   git switch --detach origin/upstream-sync
   pnpm run-local          # app must load on http://localhost:8787
   git switch main
   ```
4. Merge with **Create a merge commit**.

### Conflicts

When Karbon changes conflict with upstream, GitHub marks the PR as conflicting. Resolve on a separate branch, not on `upstream-sync`:

```sh
git fetch origin && git fetch upstream
git switch -c chore/upstream-merge-$(date +%Y%m%d) origin/main
git merge upstream/main          # resolve, run checks, commit
git push -u origin HEAD
```

Open that branch as a PR into `main`, merge it with a merge commit, then close the bot PR. The next weekly run proposes only newer commits.

### Manual sync, any time

Same commands as the conflicts case: branch from `origin/main`, `git merge upstream/main`, PR.

## Dependency updates

- Dependabot is **off**: `.github/dependabot.yml` is deleted in Karbon Atlas.
- Library upgrades arrive through the weekly upstream-sync PR, already tested by Cloudflare. Upgrading on our own would make our lockfile drift from upstream and conflict with every sync.
- When upstream edits `.github/dependabot.yml`, the sync PR shows a modify/delete conflict. Resolve it by keeping the file deleted: `git rm .github/dependabot.yml`.
- Upgrade a library ahead of upstream only for a security fix or a feature we need, on its own `chore/` branch.

## Production

- Merging to `main` deploys nothing. No workflow in this repo deploys to production.
- Upstream's Cloudflare-internal workflows (`preview`, `bonk`, `bonk-pr`, `workshop-evals`, `workshop-evals-pr`, `github-contract`, `contribution-policy`, `label-pr`) are **disabled** in the repo's Actions settings. That is repo state, not a file edit, so it survives upstream merges. `ci` stays enabled.
- A sync PR that adds a **new** upstream workflow file enables it on merge. If it is Cloudflare-internal, disable it in the Actions tab right after merging.
- When production deployment is set up, deploy from a manual step (a `workflow_dispatch` workflow with a required approval environment, or a manual `wrangler deploy`). Never connect a deploy to pushes on `main`.

## Who merges

The project owner handles product. Claude Code handles the technical side: it owns the repo work and
merges routine PRs itself. The owner granted this on 2026-11-18.

| Change | Who merges |
|---|---|
| Setup, tooling, docs, CI, refactors with no user-visible effect | Claude Code, once checks pass |
| Upstream-sync PRs | Claude Code, once checks pass, the local `pnpm run-local` test passes, and sensitive paths are reviewed |
| Dependency housekeeping (security fixes, conflict resolution) | Claude Code, once checks pass |
| Anything that changes what users see or how the product behaves | Owner approves first |
| Anything that costs money (paid services, new API keys, usage-billed models) | Owner approves first |
| Anything that touches production (deploys, prod secrets, domains) | Owner approves first |

Merging rules for everyone:
- Use **Create a merge commit** only.
- Never enable auto-merge and never bypass branch protection.
- A failed check blocks the merge. If the failure is a known flaky upstream test (same code passes on `main`), re-run it.

## Agent notes

| Tool | Reads | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` (imports this file), `AGENTS.md` | Pushes topic branches, opens PRs and merges them according to "Who merges" |
| Cursor | `AGENTS.md`, `.cursor/rules/fork-workflow.mdc` (always applied) | Same rules; the agent terminal uses the same credential helper |
| Factory Droid | `AGENTS.md` (points here) | Same rules; run git from the repo root so the credential helper finds `.secrets/.env` |

All agents:
- Run `git status` and `git branch --show-current` before any git write.
- Work on a topic branch, never on `main` or `upstream-sync`.
- Cursor and Factory Droid: never merge a PR unless the user asks in that conversation.
- Every agent: never enable auto-merge, change branch protection, or touch repo settings unless the user asks in that conversation.
- Never push to `upstream` (it is disabled anyway) or open PRs against `cloudflare/cloudflare-os`.
- Keep the dev server (`pnpm run-local`, port 8787) running; do not kill it to free the port for another task.
