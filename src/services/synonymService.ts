import { Pool } from "pg";

export interface SynonymRecord {
  id: number;
  word: string;
  synonyms: string[];
}

export class SynonymService {
  private forwardMap = new Map<string, Set<string>>();
  private lastLoad = 0;
  private cacheTtlMs = 10000; // 10 seconds cache

  constructor(private pool: Pool) {}

  /**
   * Reload synonyms from the database into the in-memory map.
   */
  public async reload(): Promise<void> {
    const res = await this.pool.query("SELECT id, word, synonyms FROM search_synonyms");
    const newForward = new Map<string, Set<string>>();
    for (const row of res.rows) {
      const word = row.word.toLowerCase().trim();
      const syns = new Set<string>(row.synonyms.map((s: string) => s.toLowerCase().trim()));
      newForward.set(word, syns);
    }
    this.forwardMap = newForward;
    this.lastLoad = Date.now();
  }

  /**
   * Get synonym-expanded list of tags.
   */
  public async expand(tags: string[]): Promise<string[]> {
    const now = Date.now();
    if (now - this.lastLoad > this.cacheTtlMs) {
      await this.reload();
    }
    
    const expanded = new Set<string>();
    for (const tag of tags) {
      const visited = new Set<string>();
      this.dfsExpand(tag.toLowerCase().trim(), expanded, visited);
    }
    return Array.from(expanded);
  }

  private dfsExpand(word: string, expanded: Set<string>, visited: Set<string>): void {
    if (visited.has(word)) return;
    visited.add(word);
    expanded.add(word);

    // Forward synonyms (word -> synonyms)
    const forward = this.forwardMap.get(word);
    if (forward) {
      for (const syn of forward) {
        this.dfsExpand(syn, expanded, visited);
      }
    }

    // Reverse synonyms (synonym -> word)
    for (const [w, syns] of this.forwardMap.entries()) {
      if (syns.has(word)) {
        this.dfsExpand(w, expanded, visited);
      }
    }
  }

  // ─── Administrative CRUD Methods ───────────────────────────────────────────

  public async getAll(): Promise<SynonymRecord[]> {
    const res = await this.pool.query("SELECT id, word, synonyms FROM search_synonyms ORDER BY id ASC");
    return res.rows;
  }

  public async getById(id: number): Promise<SynonymRecord | null> {
    const res = await this.pool.query("SELECT id, word, synonyms FROM search_synonyms WHERE id = $1", [id]);
    return res.rows[0] || null;
  }

  public async create(word: string, synonyms: string[]): Promise<SynonymRecord> {
    const normalizedWord = word.toLowerCase().trim();
    const normalizedSynonyms = synonyms.map(s => s.toLowerCase().trim()).filter(Boolean);
    
    const res = await this.pool.query(
      "INSERT INTO search_synonyms (word, synonyms) VALUES ($1, $2) RETURNING id, word, synonyms",
      [normalizedWord, normalizedSynonyms]
    );
    await this.reload();
    return res.rows[0];
  }

  public async update(id: number, word?: string, synonyms?: string[]): Promise<SynonymRecord | null> {
    // Check if it exists
    const existing = await this.getById(id);
    if (!existing) return null;

    const newWord = word !== undefined ? word.toLowerCase().trim() : existing.word;
    const newSynonyms = synonyms !== undefined 
      ? synonyms.map(s => s.toLowerCase().trim()).filter(Boolean) 
      : existing.synonyms;

    const res = await this.pool.query(
      "UPDATE search_synonyms SET word = $1, synonyms = $2 WHERE id = $3 RETURNING id, word, synonyms",
      [newWord, newSynonyms, id]
    );
    await this.reload();
    return res.rows[0] || null;
  }

  public async delete(id: number): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM search_synonyms WHERE id = $1", [id]);
    await this.reload();
    return (res.rowCount ?? 0) > 0;
  }
}
