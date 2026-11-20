import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// The live suite connects to the Data Layer's database as its read-only login: `pnpm test:live`.
// It needs DATA_LAYER_DATABASE_URL (the shell, or `.dev.vars` at the repo root) and Supabase's root
// CA in NODE_EXTRA_CA_CERTS, which Miniflare reads once at startup, so it must be in the
// environment before vitest starts; `test:live` sets it. Without both, the live suite skips.
const liveUrl = process.env.NODE_EXTRA_CA_CERTS
  ? process.env.DATA_LAYER_DATABASE_URL ?? readRootDevVar("DATA_LAYER_DATABASE_URL")
  : undefined;

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          DATA_LAYER_GATEKEEPER: { className: "DataLayerGatekeeper", useSQLite: true },
        },
        bindings: liveUrl ? { DATA_LAYER_DATABASE_URL: liveUrl } : {},
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    testTimeout: 60_000,
  },
});

/** Reads one KEY=VALUE line from the repo root's gitignored `.dev.vars`, if both exist. */
function readRootDevVar(name: string): string | undefined {
  try {
    const text = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");
    const line = text.split("\n").find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^"(.*)"$/, "$1") || undefined;
  } catch {
    return undefined;
  }
}
