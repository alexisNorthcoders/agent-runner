/**
 * Minimal Joplin Data API client (the REST API served by the Joplin desktop app or
 * `joplin server start`, default port 41184) for `claude joplin:<note>`. Reads are scoped to
 * one notebook so a WhatsApp message can't pull arbitrary notes into an agent prompt.
 */

const PAGE_LIMIT = 100;

/**
 * @param {{ baseUrl: string, token: string, notebook: string, fetchFn?: typeof fetch }} p
 */
export function createJoplinClient({ baseUrl, token, notebook, fetchFn = fetch }) {
  async function get(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries({ ...params, token })) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchFn(url.toString());
    } catch (err) {
      throw new Error(`Joplin Data API unreachable at ${baseUrl} (${err?.message || err}). Is the Joplin clipper server running?`);
    }
    if (!res.ok) throw new Error(`Joplin Data API ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  /** @returns {Promise<any[]>} */
  async function getAll(path, fields) {
    const items = [];
    for (let page = 1; ; page++) {
      const data = await get(path, { fields, page, limit: PAGE_LIMIT });
      items.push(...(data.items ?? []));
      if (!data.has_more) return items;
    }
  }

  return {
    /**
     * Find a note in the configured notebook by title (exact, case-insensitive, first), id or id
     * prefix, then partial title.
     * @param {string} query
     * @returns {Promise<{ id: string, title: string, body: string }>}
     */
    async getNote(query) {
      if (!token) throw new Error('JOPLIN_API_TOKEN is not set (Joplin → Options → Web Clipper → authorization token).');
      const q = query.trim().toLowerCase();

      const folders = await getAll('/folders', 'id,title');
      const folder = folders.find((f) => f.title.toLowerCase() === notebook.toLowerCase());
      if (!folder) throw new Error(`Joplin notebook "${notebook}" not found.`);

      const notes = await getAll(`/folders/${folder.id}/notes`, 'id,title');
      const hit =
        notes.find((n) => n.title.toLowerCase() === q) ??
        (/^[a-f0-9]{4,}$/.test(q) ? notes.find((n) => n.id.startsWith(q)) : undefined) ??
        notes.find((n) => n.title.toLowerCase().includes(q));
      if (!hit) throw new Error(`No Joplin note matching "${query}" in notebook "${notebook}".`);

      const note = await get(`/notes/${hit.id}`, { fields: 'id,title,body' });
      return { id: note.id, title: note.title, body: note.body ?? '' };
    },
  };
}
