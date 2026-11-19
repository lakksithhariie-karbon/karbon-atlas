import { CURRENT_TRANSFORM_VERSION, isTransformOutdated, stampForCleanWrite } from "./version.ts";

Deno.test("clean writes stamp the current transform version", () => {
  if (!Number.isInteger(CURRENT_TRANSFORM_VERSION) || CURRENT_TRANSFORM_VERSION < 1) {
    throw new Error("the cleaning version must be a positive integer");
  }
  if (stampForCleanWrite() !== CURRENT_TRANSFORM_VERSION) {
    throw new Error("the stamp written with clean rows must be the current version");
  }
});

Deno.test("only a lower transform version needs another clean pass", () => {
  if (!isTransformOutdated(0)) throw new Error("0 is behind 1");
  if (!isTransformOutdated(null)) throw new Error("a missing stamp is behind");
  if (isTransformOutdated(CURRENT_TRANSFORM_VERSION)) throw new Error("the current stamp is fresh");
  if (isTransformOutdated(CURRENT_TRANSFORM_VERSION + 1)) throw new Error("a newer stamp is not drained");
});
