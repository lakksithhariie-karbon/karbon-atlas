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
| Two dev watchers SIGKILLed (`configurator UI watcher for gatekeeper-homeassistant`, `app UI watcher for gatekeeper-context`) | Kernel OOM killer: ~20 `vite --watch` processes on a 16 GB host with no swap, shared with other agent processes | No fix applied. Pre-flight builds already wrote both gatekeepers' `src/generated/` output, so the app works. Only live rebuilds while editing those two packages are lost; restart `pnpm run-local` to restore them. Adding swap or freeing RAM prevents recurrence. |
| First `GET /` took 13–26 s | Cold start while watchers were building | Clears on its own; warm requests take ~10 ms |
| `list-models` returns `[]` | No LLM provider configured on a fresh instance | Add a model with a real API key (UI model settings, or `cf-os api add-model`) |

## Verification results

- `GET /` and every asset it references return 200.
- Password account creation, `whoami`, and workspace creation work over Cap'n Web RPC.
- An agent turn with a placeholder Anthropic key reaches `api.anthropic.com` and returns `401 invalid x-api-key` as a chat error. The whole chat → agent → provider path works up to the credential.

## Not configured (by request)

- Supabase gatekeeper
- Any OAuth gatekeeper credentials (GitHub, Google, Slack, …)
- Real LLM provider key
