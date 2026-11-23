/**
 * Read-only Mixpanel client. The pipeline's login is an Analyst on Korefi Prod, which could also edit
 * boards, feature flags and webhooks, so this module only builds the read URLs below and nothing else:
 *   GET  data.mixpanel.com/api/2.0/export        raw events for one UTC day
 *   GET  mixpanel.com/api/query/events/names      event names seen recently
 *   GET  mixpanel.com/api/query/events            per-event daily counts (IST days, the report numbers)
 *   POST mixpanel.com/api/query/engage            user and company profiles (a read; Mixpanel uses POST)
 *   GET  mixpanel.com/api/app/projects/{id}/data-groups   the company group key id
 */

import type { MixpanelEvent } from "./transform.ts";

const EXPORT_HOST = "https://data.mixpanel.com";
const QUERY_HOST = "https://mixpanel.com";

export interface MixpanelConfig {
  projectId: string;
  username: string;
  secret: string;
}

export function configFromEnv(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): MixpanelConfig {
  const projectId = get("MIXPANEL_PROJECT_ID") ?? "";
  const username = get("MIXPANEL_SERVICE_ACCOUNT_USERNAME") ?? "";
  const secret = get("MIXPANEL_SERVICE_ACCOUNT_SECRET") ?? "";
  if (!/^\d+$/.test(projectId) || !username || !secret) throw new Error("Mixpanel credentials are not set");
  return { projectId, username, secret };
}

export class Mixpanel {
  /** HTTP requests made, including retries, for the run log. */
  requests = 0;
  #auth: string;

  constructor(private readonly cfg: MixpanelConfig) {
    this.#auth = "Basic " + btoa(`${cfg.username}:${cfg.secret}`);
  }

  async #fetch(url: URL, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      this.requests += 1;
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: this.#auth, Accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      // The body is discarded, never logged or stored: it is upstream text outside the cleaning rules.
      await res.body?.cancel();
      if (!retryable || attempt >= 3) throw new Error(`Mixpanel ${url.pathname} HTTP ${res.status}`);
      const wait = Math.min(Number(res.headers.get("Retry-After")) || 5 * attempt, 30);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  /** All raw events whose UTC date is `utcDay`. Mixpanel's export splits days in UTC. */
  async exportUtcDay(utcDay: string): Promise<MixpanelEvent[]> {
    const url = new URL("/api/2.0/export", EXPORT_HOST);
    url.searchParams.set("project_id", this.cfg.projectId);
    url.searchParams.set("from_date", utcDay);
    url.searchParams.set("to_date", utcDay);
    const res = await this.#fetch(url, { headers: { Accept: "text/plain" } });
    const text = await res.text();
    const out: MixpanelEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as MixpanelEvent);
    }
    return out;
  }

  /** Event names Mixpanel saw in the last 31 days. */
  async eventNames(): Promise<string[]> {
    const url = new URL("/api/query/events/names", QUERY_HOST);
    url.searchParams.set("project_id", this.cfg.projectId);
    url.searchParams.set("type", "general");
    url.searchParams.set("limit", "255");
    return await (await this.#fetch(url)).json() as string[];
  }

  /**
   * Mixpanel's own per-event totals for each IST day in [fromDay, toDay]: { day: { event: count } }.
   * These are the numbers Mixpanel's reports show.
   */
  async dailyCounts(events: string[], fromDay: string, toDay: string): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (let i = 0; i < events.length; i += 100) {
      const url = new URL("/api/query/events", QUERY_HOST);
      url.searchParams.set("project_id", this.cfg.projectId);
      url.searchParams.set("event", JSON.stringify(events.slice(i, i + 100)));
      url.searchParams.set("type", "general");
      url.searchParams.set("unit", "day");
      url.searchParams.set("from_date", fromDay);
      url.searchParams.set("to_date", toDay);
      const body = await (await this.#fetch(url)).json() as { data?: { values?: Record<string, Record<string, number>> } };
      for (const [event, byDay] of Object.entries(body.data?.values ?? {})) {
        for (const [day, n] of Object.entries(byDay)) {
          if (!n) continue;
          (out[day] ??= {})[event] = n;
        }
      }
    }
    return out;
  }

  /** Id of the company group (Group Analytics key `company`), or null when none is set up. */
  async companyGroupId(): Promise<number | null> {
    const url = new URL(`/api/app/projects/${this.cfg.projectId}/data-groups`, QUERY_HOST);
    const body = await (await this.#fetch(url)).json() as { results?: Array<{ data_group_id?: number; property_name?: string }> };
    const group = (body.results ?? []).find((g) => g.property_name === "company");
    return group?.data_group_id ?? null;
  }

  /**
   * Every profile, asking Mixpanel for `outputProperties` only. Pages until Mixpanel returns a short page.
   * Profiles hold personal data, so callers keep only what they need and drop the rest in memory.
   */
  async profiles(outputProperties: string[], dataGroupId?: number): Promise<Array<{ id: string; props: Record<string, unknown> }>> {
    const out: Array<{ id: string; props: Record<string, unknown> }> = [];
    let page = 0;
    let sessionId: string | undefined;
    for (;;) {
      const form = new URLSearchParams();
      form.set("project_id", this.cfg.projectId);
      form.set("output_properties", JSON.stringify(outputProperties));
      if (dataGroupId !== undefined) form.set("data_group_id", String(dataGroupId));
      if (sessionId) {
        form.set("session_id", sessionId);
        form.set("page", String(page));
      }
      const url = new URL("/api/query/engage", QUERY_HOST);
      const res = await this.#fetch(url, {
        method: "POST",
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body = await res.json() as {
        results?: Array<{ $distinct_id?: string; $properties?: Record<string, unknown> }>;
        session_id?: string;
        page_size?: number;
        page?: number;
      };
      const results = body.results ?? [];
      for (const r of results) if (r.$distinct_id) out.push({ id: r.$distinct_id, props: r.$properties ?? {} });
      if (results.length === 0 || results.length < (body.page_size ?? 1000) || !body.session_id) break;
      sessionId = body.session_id;
      page = (body.page ?? page) + 1;
      if (page > 200) throw new Error("engage paging did not end");
    }
    return out;
  }
}
