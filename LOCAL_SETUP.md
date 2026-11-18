# Local setup notes (Karbon Atlas / Cloudflare OS)

Local-only record of how this checkout was brought up. Not part of upstream.

- **Date:** 2026-11-18
- **Upstream:** https://github.com/cloudflare/cloudflare-os @ `ad7f4eec`
- **Host:** Linux, 4 cores, 16 GB RAM, no swap, Node v26.10.0

## Steps

1. Clone into the project directory:
   ```sh
   git clone https://github.com/cloudflare/cloudflare-os .
   ```
2. Install pnpm at the version pinned in `package.json` (`packageManager`). Node 26 ships no corepack, so install it globally:
   ```sh
   npm install -g pnpm@11.17.0
   ```
3. Start the stack. This runs `pnpm install`, builds `@gadgets/typed-storage` and the frontend bundle, then launches `wrangler dev` with the backend, router, all gatekeepers and the PDF renderer:
   ```sh
   pnpm run-local
   ```
4. Open http://localhost:8787. Local data lives in `.wrangler/`.

## Verifying with the API CLI

```sh
export CFOS_API_PASSWORD=<any local password>
pnpm cf-os api create-account tester
pnpm cf-os api --username tester whoami
pnpm cf-os api --username tester new-workspace set-title "Setup Check"   # prints workspace id
pnpm cf-os api --username tester add-model '<profile json>' '<config json>'
pnpm cf-os api --username tester open-workspace <ws> new-chat "Say hello" <modelId>
pnpm cf-os api --username tester open-workspace <ws> wait-for-agent <chatId> --timeout 120
```

## Issues encountered

| Issue | Cause | Resolution |
|---|---|---|
| `pnpm: command not found` | Node 26 has no corepack | `npm install -g pnpm@11.17.0` |
| Dev watchers SIGKILLed on first start (`configurator UI watcher for gatekeeper-homeassistant`, `app UI watcher for gatekeeper-context`) | Kernel OOM killer. All 29 kills on 2026-11-18 fell in one 2-minute window (09:44–09:46) while `run-local` did its first full build, on a 16 GB / 4 vCPU host with no swap, shared with other agent processes. Steady state afterwards: ~8 GB available. | See [Memory pressure](#memory-pressure). Killed watchers only stop live rebuilds for their package; restart `pnpm run-local` to restore them. |
| First `GET /` took 13–26 s | Cold start while watchers were building | Clears on its own; warm requests take ~10 ms |
| `list-models` returns `[]` | No LLM provider configured on a fresh instance | Add a model with a real API key (UI model settings, or `cf-os api add-model`) |
| Browser tests fail locally: `Executable doesn't exist at ~/.cache/ms-playwright/chromium_headless_shell-1254/...` | Playwright's browser isn't installed (CI installs it on every run) | `pnpm --filter @gadgets/workshop-frontend exec playwright install --only-shell chromium` |

## Memory pressure

- **Recommended fix:** an 8 GB swap file. With swap, a startup spike slows the machine for a moment instead of killing processes. Run once as root (persists across reboots):
  ```sh
  fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-karbon-swap.conf && sysctl -p /etc/sysctl.d/99-karbon-swap.conf
  ```
  `vm.swappiness=10` keeps swap for emergencies only. Undo: `swapoff /swapfile && rm /swapfile`, then remove the fstab line and the sysctl file.
- **Why not a repo setting:** `run-local` sizes build concurrency from the machine (`scripts/vp/concurrency.ts`). On this host it already picks the minimum of 4. `VP_RUN_CONCURRENCY_LIMIT=2` would lower the peak but slow every start, and it goes in the root `.env`, which Wrangler also loads (see FORK_WORKFLOW.md).
- **Also helps:** avoid starting `pnpm run-local`, a full `pnpm test`, and other agents' builds at the same time. The peak is the first few minutes of each.

## Known flaky CI test

`CodeDiffEditor.overview.browser.test.tsx > the overview strip (split) > reaches each of two changes whose marks overlap near the end of a long file` (frontend browser suite).

- Added upstream on 2026-11-17 (#1186). It is upstream's test, not ours.
- **In our CI:** it failed 2 of 5 runs on 2026-11-18 (PR #2 attempt 1 and `main` after merging #2). Each time the same frontend code passed on a re-run or on another commit, and none of our commits touch frontend code.
- **Locally:** it passed 16 of 16 runs, including 6 pinned to one CPU core.
- **Upstream CI:** it passed all 5 `main` runs since it was added.
- **Cause (likely):** timing. It scrolls a 10,000-line diff by clicking a 2px mark, then checks that a line is in view. On a busy CI runner the check can run before the scroll settles.
- **Action:** re-run the failed job. Don't edit the test here, because changing upstream files creates sync conflicts. If it keeps failing after upstream syncs, report it upstream.

## Verification results

- `GET /` and every asset it references return 200.
- Password account creation, `whoami`, and workspace creation work over Cap'n Web RPC.
- An agent turn with a placeholder Anthropic key reaches `api.anthropic.com` and returns `401 invalid x-api-key` as a chat error. The whole chat → agent → provider path works up to the credential.
- 2026-11-18: OpenRouter `meta/muse-ember` connected through the built-in `openai` provider (`apiUrl` `https://openrouter.ai/api/v1`). An agent turn replied and made tool calls.

## Not configured (by request)

- Supabase gatekeeper
- Any OAuth gatekeeper credentials (GitHub, Google, Slack, …)
