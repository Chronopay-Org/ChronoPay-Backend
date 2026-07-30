interface BKNode {
  word: string;
  children: Record<number, BKNode>;
}

export class BKTree {
  private root: BKNode | null = null;

  constructor(words: string[] = []) {
    for (const word of words) {
      this.insert(word);
    }
  }

  public insert(word: string): void {
    const normalized = word.toLowerCase().trim();
    if (!normalized) return;

    if (this.root === null) {
      this.root = { word: normalized, children: {} };
      return;
    }

    let curr = this.root;
    while (true) {
      if (curr.word === normalized) {
        return; // Already exists
      }
      const dist = getLevenshteinDistance(curr.word, normalized);
      if (curr.children[dist]) {
        curr = curr.children[dist];
      } else {
        curr.children[dist] = { word: normalized, children: {} };
        return;
      }
    }
  }

  public search(query: string, maxDistance: number): string[] {
    const normalized = query.toLowerCase().trim();
    const results: string[] = [];
    if (!normalized || this.root === null) {
      return results;
    }

    const queue: BKNode[] = [this.root];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const dist = getLevenshteinDistance(curr.word, normalized);
      if (dist <= maxDistance) {
        results.push(curr.word);
      }
      const minDist = dist - maxDistance;
      const maxDist = dist + maxDistance;
      for (const dStr of Object.keys(curr.children)) {
        const d = parseInt(dStr, 10);
        if (d >= minDist && d <= maxDist) {
          queue.push(curr.children[d]);
        }
      }
    }
    return results;
  }
}

export function getLevenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1, // deletion
        tmp[i][j - 1] + 1, // insertion
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
  }
  return tmp[a.length][b.length];
}

export function getEditDistanceCap(queryLength: number): number {
  if (queryLength <= 2) {
    return 0; // Exact match only for 2 chars or fewer
  }
  if (queryLength <= 5) {
    return 1; // 1 edit distance for 3-5 chars
  }
  return 2; // 2 edit distance for 6+ chars
}
