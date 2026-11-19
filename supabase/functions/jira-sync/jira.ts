/**
 * Read-only Jira Cloud client.
 * POST is limited to changelog bulk fetch. Everything else is GET.
 * At most four requests run at once. 429 waits for Retry-After, 5xx backs off with jitter,
 * and a low x-ratelimit-remaining slows the next request.
 */

const MAX_CONCURRENT = 4;
const CHANGELOG_PATH = "/rest/api/3/changelog/bulkfetch";

export interface SearchPage {
  issues: unknown[];
  nextPageToken: string | null;
  isLast: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  const base = Math.min(15_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random()));
}

function basicAuth(email: string, token: string): string {
  const bytes = new TextEncoder().encode(`${email}:${token}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class JiraClient {
  requests = 0;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private slowUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
  ) {}

  static fromEnv(): JiraClient {
    const baseUrl = Deno.env.get("JIRA_BASE_URL");
    const email = Deno.env.get("JIRA_EMAIL");
    const token = Deno.env.get("JIRA_API_TOKEN");
    if (!baseUrl || !email || !token) throw new Error("Jira credentials are not set");
    return new JiraClient(baseUrl.replace(/\/$/, ""), basicAuth(email, token));
  }

  async searchPage(jql: string, fields: string, nextPageToken?: string | null): Promise<SearchPage> {
    const fieldParam = fields === "*all" ? "*all" : encodeURIComponent(fields);
    let path = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fieldParam}`;
    if (nextPageToken) path += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    const body = asRecord(await this.get(path));
    const issues = Array.isArray(body?.issues) ? body.issues : [];
    const token = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
    return { issues, nextPageToken: token, isLast: body?.isLast === true };
  }

  /** Page the per-issue endpoint when the search payload did not include every comment. */
  async fullComments(issueId: string, inline: unknown): Promise<unknown[]> {
    return await this.fullChild(issueId, inline, "comment", "comments");
  }

  /** Page the per-issue endpoint when the search payload did not include every worklog. */
  async fullWorklogs(issueId: string, inline: unknown): Promise<unknown[]> {
    return await this.fullChild(issueId, inline, "worklog", "worklogs");
  }

  async fetchChangelogs(issueIds: string[]): Promise<Map<string, unknown[]>> {
    const histories = new Map<string, unknown[]>();
    if (issueIds.length === 0) return histories;
    let token: string | null = null;
    for (;;) {
      const payload: Record<string, unknown> = { issueIdsOrKeys: issueIds, maxResults: 1000 };
      if (token) payload.nextPageToken = token;
      const body = asRecord(await this.post(CHANGELOG_PATH, payload));
      const entries = Array.isArray(body?.issueChangeLogs) ? body.issueChangeLogs : [];
      for (const entry of entries) {
        const row = asRecord(entry);
        if (!row) continue;
        const issueId = typeof row.issueId === "string" || typeof row.issueId === "number"
          ? String(row.issueId)
          : "";
        if (!issueId) continue;
        const page = Array.isArray(row.changeHistories) ? row.changeHistories : [];
        const existing = histories.get(issueId) ?? [];
        existing.push(...page);
        histories.set(issueId, existing);
      }
      const next = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
      if (!next) break;
      token = next;
    }
    return histories;
  }

  async get(path: string): Promise<unknown> {
    return await this.request("GET", path);
  }

  async timeZone(): Promise<string> {
    const body = asRecord(await this.get("/rest/api/3/myself"));
    const zone = body?.timeZone;
    if (typeof zone !== "string" || zone.length === 0) throw new Error("GET /rest/api/3/myself failed with no time zone");
    return zone;
  }

  private async fullChild(
    issueId: string,
    inline: unknown,
    resource: "comment" | "worklog",
    listKey: "comments" | "worklogs",
  ): Promise<unknown[]> {
    const page = asRecord(inline);
    const inlineItems = Array.isArray(page?.[listKey]) ? page[listKey] : [];
    const total = typeof page?.total === "number" ? page.total : inlineItems.length;
    if (total <= inlineItems.length) return inlineItems;
    const all: unknown[] = [];
    let startAt = 0;
    for (;;) {
      const body = asRecord(await this.get(
        `/rest/api/3/issue/${encodeURIComponent(issueId)}/${resource}?startAt=${startAt}&maxResults=100`,
      ));
      const batch = Array.isArray(body?.[listKey]) ? body[listKey] : [];
      all.push(...batch);
      const reported = typeof body?.total === "number" ? body.total : total;
      startAt += batch.length;
      if (batch.length === 0 || startAt >= reported) break;
    }
    return all;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    if (path !== CHANGELOG_PATH) throw new Error("POST is not allowed for this path");
    return await this.request("POST", path, payload);
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight -= 1;
  }

  private async request(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    const safePath = path.split("?")[0] ?? path;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.acquire();
      let retryMs = 0;
      let failed: Error | null = null;
      let body: unknown = undefined;
      let done = false;
      try {
        const pause = this.slowUntil - Date.now();
        if (pause > 0) await sleep(pause);
        this.requests += 1;
        const headers = {
          Authorization: this.authorization,
          Accept: "application/json",
        };
        const response = method === "POST"
          ? await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(payload ?? {}),
          })
          : await fetch(`${this.baseUrl}${path}`, { method: "GET", headers });
        const remaining = Number(response.headers.get("x-ratelimit-remaining"));
        if (Number.isFinite(remaining) && remaining < 20) {
          this.slowUntil = Math.max(this.slowUntil, Date.now() + 1000);
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          await response.body?.cancel();
          retryMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000;
        } else if (response.status >= 500) {
          await response.body?.cancel();
          retryMs = backoff(attempt);
        } else if (!response.ok) {
          failed = new Error(`${method} ${safePath} failed with ${response.status}`);
        } else {
          body = await response.json();
          done = true;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`${method} `)) failed = error;
        else retryMs = backoff(attempt);
      } finally {
        this.release();
      }
      if (failed) throw failed;
      if (done) return body;
      if (retryMs > 0) await sleep(retryMs);
    }
    throw new Error(`${method} ${safePath} failed after retries`);
  }
}
