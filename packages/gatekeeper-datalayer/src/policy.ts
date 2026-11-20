// Who may read which schema. Today: every account on this deployment may read every company
// function schema (`f<NN>_<function>`) that the Data Layer's database login can use. Per-department
// rules replace `policyAllowsSchema()` (and give it the account to decide for).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

/** A company function schema: `f01_engineering`, `f02_product`, … */
const FUNCTION_SCHEMA = /^f\d{2}_[a-z0-9_]+$/;

/** Whether the deployment's policy lets an account read `schema`. */
export function policyAllowsSchema(schema: string): boolean {
  return FUNCTION_SCHEMA.test(schema);
}

/** The subresource ID an observation reports for reading `schema`: `schema/<name>`. */
export function schemaSubresource(schema: string): string {
  return formatSubresourceId({ fragments: [{ name: "schema", id: schema }] });
}

/** The schema a subresource ID names. Throws on any other shape. */
export function parseSchemaSubresource(id: string): string {
  const { namespace, fragments } = parseSubresourceId(id);
  const [fragment, ...rest] = fragments;
  if (namespace !== undefined || !fragment || rest.length > 0 || fragment.name !== "schema") {
    throw new Error(`Unknown Data Layer subresource ID: ${id}`);
  }
  return fragment.id;
}
