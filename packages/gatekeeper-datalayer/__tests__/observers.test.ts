import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DataLayerGatekeeper } from "../src/worker.js";
import { parseSchemaSubresource, policyAllowsSchema, schemaSubresource } from "../src/policy.js";

describe("schema subresources", () => {
  it("name a schema as schema/<name> and read back only that shape", () => {
    expect(schemaSubresource("f01_engineering")).toBe("schema/f01_engineering");
    expect(parseSchemaSubresource("schema/f01_engineering")).toBe("f01_engineering");
    for (const id of ["global", "table/f01_engineering", "schema/a/table/b", "datalayer/schema/x", "schema"]) {
      expect(() => parseSchemaSubresource(id), id).toThrow();
    }
  });

  it("allow company function schemas only", () => {
    expect(policyAllowsSchema("f01_engineering")).toBe(true);
    expect(policyAllowsSchema("f12_finance")).toBe(true);
    for (const schema of ["ingest", "net", "public", "f1_x", "f01-engineering", "F01_engineering", "f01_"]) {
      expect(policyAllowsSchema(schema), schema).toBe(false);
    }
  });
});

const facet = () => env.DATA_LAYER_GATEKEEPER.getByName(crypto.randomUUID());
const verifier = () => createExecutionContext().exports.DataLayerAccount({}).getVerifier();

describe("verifyObserverAccess", () => {
  it("admits observers with a Data Layer account for company schemas", async () => {
    const [owner, colleague] = [await verifier(), await verifier()];
    await expect(facet().verifyObserverAccess(
      [{ id: "owner", verifier: owner }, { id: "colleague", verifier: colleague }],
      ["schema/f01_engineering"],
    )).resolves.toEqual({ allowedObserverIds: ["owner", "colleague"] });
  });

  it("denies a schema the policy does not cover, for everyone", async () => {
    await expect(facet().verifyObserverAccess(
      [{ id: "owner", verifier: await verifier() }],
      ["schema/f01_engineering", "schema/ingest"],
    )).resolves.toEqual({ allowedObserverIds: [] });
  });

  it("throws on IDs it does not issue, and on an empty question", async () => {
    // Inside the facet, so the refusals reject here rather than across its RPC boundary.
    await runInDurableObject(facet(), async (gatekeeper: DataLayerGatekeeper) => {
      const observers = [{ id: "owner", verifier: await verifier() }];
      await expect(gatekeeper.verifyObserverAccess(observers, ["global"])).rejects.toThrow(/Unknown|subresource/i);
      await expect(gatekeeper.verifyObserverAccess(observers, ["project/1"])).rejects.toThrow(/Unknown/);
      await expect(gatekeeper.verifyObserverAccess(observers, [])).rejects.toThrow();
    });
  });

  it("keeps no observer history", async () => {
    const gatekeeper = facet();
    await gatekeeper.addObserver("x", await verifier());
    await gatekeeper.removeObserver("x");
    await expect(gatekeeper.getHistoricalSubresources()).resolves.toEqual([]);
  });
});
