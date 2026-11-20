/// <reference types="@cloudflare/vitest-plugin/types" />

import type { DataLayerGatekeeper } from "../src/worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared only in vitest.config.ts; production reaches this class through facets.
      DATA_LAYER_GATEKEEPER: DurableObjectNamespace<DataLayerGatekeeper>;
    }
  }
}
