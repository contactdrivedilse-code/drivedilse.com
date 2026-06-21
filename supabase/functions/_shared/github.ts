// Commits generated static blog pages directly to the site's GitHub repo,
// which Vercel auto-deploys from — this is how a "Publish" click in the
// admin panel turns into a real, crawlable static page without needing a
// separate build pipeline.

const OWNER  = Deno.env.get("GITHUB_OWNER")!;
const REPO   = Deno.env.get("GITHUB_REPO")!;
const BRANCH = Deno.env.get("GITHUB_BRANCH") || "main";
const TOKEN  = Deno.env.get("GITHUB_TOKEN")!;

async function ghFetch(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "drivedilse-blog-publisher",
    },
  });
  if (res.status === 404) return { __notFound: true };
  const data = await res.json();
  if (!res.ok) throw new Error("GitHub API error: " + JSON.stringify(data));
  return data;
}

function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

// Creates or updates a file at the given repo path with the given content.
export async function putFile(filePath: string, content: string, message: string): Promise<void> {
  const existing = await ghFetch(`contents/${filePath}?ref=${BRANCH}`);
  const sha = existing.__notFound ? undefined : (existing.sha as string);
  await ghFetch(`contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: toBase64(content),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
}

// Deletes a file (used when unpublishing/deleting a post). No-ops if the
// file doesn't exist (e.g. unpublishing a post that was never published).
export async function deleteFile(filePath: string, message: string): Promise<void> {
  const existing = await ghFetch(`contents/${filePath}?ref=${BRANCH}`);
  if (existing.__notFound) return;
  await ghFetch(`contents/${filePath}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha: existing.sha as string, branch: BRANCH }),
  });
}
