import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-datalayer",
  // nodejs_compat: postgres.js's workerd build imports node:buffer and node:stream.
  compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  // DATA_LAYER_DATABASE_URL is a deployment secret: `pnpm dev-server` passes it through from the
  // root `.dev.vars`, and it is never committed.
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** The workspace facet is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["DataLayerGatekeeper"] },
];
