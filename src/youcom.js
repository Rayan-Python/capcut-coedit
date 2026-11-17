// You.com Search API client (POST /v1/search, per https://you.com/docs).
import { fileURLToPath } from "node:url";

// Load YDC_API_KEY from the project's .env (gitignored) if it isn't already set.
try {
  if (!process.env.YDC_API_KEY) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {}

const ENDPOINT = "https://ydc-index.io/v1/search";

/**
 * Live web search. `freshness`: day | week | month | year | YYYY-MM-DDtoYYYY-MM-DD.
 * Returns [{ title, url, snippet, age }] — every claim built on these can cite `url`.
 */
export async function research(query, { count = 8, freshness } = {}) {
  const key = process.env.YDC_API_KEY;
  if (!key) throw new Error("YDC_API_KEY is not set. Put YDC_API_KEY=... in the project's .env file.");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, count, ...(freshness ? { freshness } : {}) }),
  });
  if (!res.ok) throw new Error(`You.com search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.results?.web ?? []).map((h) => ({
    title: h.title,
    url: h.url,
    snippet: [h.description, ...(h.snippets ?? [])].filter(Boolean).join(" ").slice(0, 600),
    age: h.page_age ?? null,
  }));
}
