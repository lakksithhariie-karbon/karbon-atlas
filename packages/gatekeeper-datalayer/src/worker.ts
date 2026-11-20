// Data Layer: an auto-provisioned gatekeeper whose account gives the agent and gadgets a
// `DATA_LAYER` binding: read-only SQL over Karbon's company data in Supabase, with no sign-in or
// approval. README.md is the design record; src/types.d.ts is the agent's API.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationDescription,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import {
  connect, describeTable, listSchemas, listTables, prepareQuery, publicError, runQuery,
} from "./database.js";
import { parseSchemaSubresource, policyAllowsSchema, schemaSubresource } from "./policy.js";
import type {
  DataLayer, DataLayerQueryResult, DataLayerSchema, DataLayerTable, DataLayerTableDetails,
  DataLayerValue,
} from "./types.js";
import TYPES_CODE from "./types.txt";

const DATA_LAYER_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='16'>" +
        "<ellipse cx='128' cy='64' rx='80' ry='32'/>" +
        "<path d='M48 64v128c0 17.7 35.8 32 80 32s80-14.3 80-32V64'/>" +
        "<path d='M48 128c0 17.7 35.8 32 80 32s80-14.3 80-32'/></svg>",
    ),
};

/** Every observation reports its subresources; the type makes leaving them out an error here. */
type Observation = ObservationDescription & { subresources: string[] };

type Sql = ReturnType<typeof connect>;

/** Runs `fn` with a database call wrapper that hides connection details from the caller. */
type Db = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

function describe(intro: string, schemas: readonly string[], extra?: (b: ReturnType<typeof buildDescription>) => void): Omit<Observation, "title"> {
  const builder = buildDescription(intro);
  extra?.(builder);
  const { description, fields } = builder.finish();
  return { description, fields, subresources: schemas.map(schemaSubresource) };
}

function schemaList(schemas: readonly string[]): string {
  return schemas.length === 0 ? "no schema" : schemas.map(s => `\`${s}\``).join(", ");
}

@validateRpc()
class DataLayerSessionImpl extends RpcTarget implements DataLayer {
  readonly #env: Cloudflare.Env;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(env: Cloudflare.Env, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#env = env;
    this.#approvalQueue = approvalQueue;
  }

  /** Lists the readable schemas. Reports every one it lists. */
  async listSchemas(): Promise<DataLayerSchema[]> {
    return await this.#connected(async db => {
      const schemas = await db(listSchemas);
      const names = schemas.map(s => s.name);
      await this.#authorize({
        title: "List company data schemas",
        ...describe(`Lists the company data schemas this account may read: ${schemaList(names)}.`, names),
      });
      return schemas;
    });
  }

  /** Lists the tables and views in one schema. */
  async listTables(schema: string): Promise<DataLayerTable[]> {
    return await this.#connected(async db => {
      const tables = await db(sql => listTables(sql, schema));
      await this.#authorize({
        title: `List tables in ${schema}`,
        ...describe(`Lists the tables and views in \`${schema}\`, with their descriptions.`, [schema]),
      });
      return tables;
    });
  }

  /** Describes one table or view. */
  async describeTable(schema: string, name: string): Promise<DataLayerTableDetails> {
    return await this.#connected(async db => {
      const details = await db(sql => describeTable(sql, schema, name));
      await this.#authorize({
        title: `Describe ${schema}.${name}`,
        ...describe(`Reads the columns and description of \`${schema}.${name}\`.`, [schema]),
      });
      return details;
    });
  }

  /**
   * Checks the query, records it with the schemas it reads, then runs it. The record comes before
   * the query runs, so a refused or failed record stops it.
   */
  async query(sql: string, params?: DataLayerValue[]): Promise<DataLayerQueryResult> {
    const values = params ?? [];
    return await this.#connected(async db => {
      const prepared = await db(c => prepareQuery(c, sql, values));
      await this.#authorize({
        title: "Query company data",
        ...describe(`Runs a read-only SQL query on ${schemaList(prepared.schemas)}.`, prepared.schemas, b => {
          b.verbatim("SQL", sql, "sql");
          if (values.length > 0) b.json("Parameters", values);
        }),
      });
      return await db(c => runQuery(c, prepared));
    });
  }

  // One connection per call: a Worker can't keep one between requests. Errors from the database
  // pass through `publicError()`; errors from recording the observation pass through unchanged.
  async #connected<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const url = this.#env.DATA_LAYER_DATABASE_URL;
    if (!url) throw new Error("The Data Layer has no database configured on this deployment.");
    const sql = connect(url);
    const db: Db = async f => {
      try {
        return await f(sql);
      } catch (error) {
        throw publicError(error);
      }
    };
    try {
      return await fn(db);
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }

  #authorize(observation: Observation): Promise<void> {
    return this.#approvalQueue.authorizeObservation(observation);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }
}

/** The account-side access check the Workshop hands back to `verifyObserverAccess()`. */
export interface DataLayerVerifierApi extends GatekeeperUserVerifier {
  /** For each subresource ID, whether this account's policy lets it read that schema. */
  canReadSubresources(ids: string[]): Promise<boolean[]>;
}

@validateRpc()
export class DataLayerGatekeeper
  extends DurableObject<Cloudflare.Env>
  implements Gatekeeper<DataLayer>
{
  // Each observer is checked with its own account's verifier, never with this workspace's owner.
  readonly #verify = observerAccessVerifier<DataLayerVerifierApi>({
    hasCollectionAccess: (verifier, ids) => verifier.canReadSubresources([...ids]),
  });

  /** Describes the ambient Data Layer binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "datalayer://karbon",
      title: "Data Layer",
      snippet: "Read-only SQL over Karbon's company data.",
      suggestedBindingName: "DATA_LAYER",
      tsType: "DataLayer",
    };
  }

  /** Returns the agent-facing DataLayer declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Reports that the Data Layer has no actions: it only reads. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session that records each read through `approvalQueue`. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<DataLayer> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new DataLayerSessionImpl(this.env, approvalQueue.dup());
  }

  /** Returns no catalog: `listSchemas()` is the discovery call, and it is an observation. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** No-op: observers are checked per read, through `verifyObserverAccess()`. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** No-op: no observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  /** No legacy observer history: this gatekeeper was written to the current contract. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /** Returns the observers whose own accounts may read every reported schema. */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return await this.#verify(observers, subresources);
  }

  applyAction(_action: number): Promise<void> {
    throw new Error("The Data Layer implements no actions.");
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error("The Data Layer implements no actions.");
  }

  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The Data Layer implements no actions.");
  }
}

@validateRpc()
export class DataLayerAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account: an agent singleton and no management UI. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Data Layer",
      avatar: DATA_LAYER_ICON,
      singleton: { tsType: "DataLayer" },
    };
  }

  /** Returns the workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<DataLayer>>> {
    return this.ctx.exports.DataLayerGatekeeper({});
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Data Layer has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Data Layer has no URL-addressed resources.");
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: the account holds no credentials and no state. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The Data Layer has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The Data Layer has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints this account's access check, which `verifyObserverAccess()` asks about each observer. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.DataLayerVerifier({});
  }
}

@validateRpc()
export class DataLayerVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements DataLayerVerifierApi
{
  /**
   * Answers from the deployment's schema policy (`policy.ts`). Holding this verifier proves the
   * observer has a Data Layer account on this deployment, which, with signups off, means an
   * account an admin created. Throws on any ID that is not a schema.
   */
  async canReadSubresources(ids: string[]): Promise<boolean[]> {
    return ids.map(id => policyAllowsSchema(parseSchemaSubresource(id)));
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Data Layer vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Data Layer",
      url: "https://github.com/lakksithhariie-karbon/karbon-atlas/tree/main/packages/gatekeeper-datalayer",
      logo: DATA_LAYER_ICON,
      tagline: "Karbon's company data, read-only",
      description:
        "Let the agent and gadgets read Karbon's company data (engineering metrics from Jira today) " +
        "with read-only SQL. No sign-in or approval needed.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. All accounts are alike: none holds credentials or state. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.DataLayerAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The Data Layer is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the agent-facing DataLayer declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
