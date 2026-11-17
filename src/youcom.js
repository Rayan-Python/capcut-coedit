// You.com Search API client. Needs YDC_API_KEY in the environment.
// NOTE: endpoint/shape written from memory of the You.com API; verify against
// https://docs.you.com before relying on it.
import { fileURLToPath } from "node:url";

// Load YDC_API_KEY from the project's .env (gitignored) if it isn't already set.
try {
  if (!process.env.YDC_API_KEY) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {}

const ENDPOINT = "https://api.ydc-index.io/search";

export async function research(query, { count = 8, freshness } = {}) {
  const key = process.env.YDC_API_KEY;
  if (!key) throw new Error("YDC_API_KEY is not set. Get a key from you.com and export it.");
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(count));
  if (freshness) url.searchParams.set("freshness", freshness);
  const res = await fetch(url, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`You.com ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const hits = data.results?.web ?? data.hits ?? [];
  return hits.slice(0, count).map((h) => ({
    title: h.title,
    url: h.url,
    snippet: h.description ?? h.snippets?.join(" ") ?? "",
    age: h.page_age ?? null,
  }));
}
