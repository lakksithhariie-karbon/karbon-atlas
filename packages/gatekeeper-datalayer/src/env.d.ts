// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // The read-only login's Postgres URL (Supabase's transaction pooler). A deployment secret:
    // `pnpm dev-server` passes it through from the root `.dev.vars`. Unset, every call fails.
    DATA_LAYER_DATABASE_URL?: string;
  }
}
