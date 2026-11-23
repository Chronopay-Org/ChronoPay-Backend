import fs from 'fs/promises';
import path from 'path';

export interface RatingEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CollusionConfig {
  /** Maximum length of a cycle to detect. Prevents giant SCC explosions. Default 5 */
  maxCycleLength?: number;
  /** Minimum average edge weight for a cycle to be flagged. Default 3.0 */
  minCycleWeight?: number;
  /** Threshold specifically for 2-node cycles (symmetric ratings) to reduce false positives. Default 5.0 */
  symmetricRatingThreshold?: number;
}

export interface Cycle {
  nodes: string[];
  edges: RatingEdge[];
  averageWeight: number;
}

export class CollusionAnalyzer {
  private graph = new Map<string, RatingEdge[]>();
  private config: Required<CollusionConfig>;

  constructor(config: CollusionConfig = {}) {
    this.config = {
      maxCycleLength: config.maxCycleLength || 5,
      minCycleWeight: config.minCycleWeight || 3.0,
      symmetricRatingThreshold: config.symmetricRatingThreshold || 5.0,
    };
  }

  /**
   * Adds a directed rating edge from source to target.
   */
  addRating(source: string, target: string, weight: number): void {
    const edges = this.graph.get(source) || [];
    edges.push({ source, target, weight });
    this.graph.set(source, edges);
  }

  /**
   * Detects simple cycles up to maxCycleLength.
   */
  detectCycles(): Cycle[] {
    const cycles: Cycle[] = [];
    const visited = new Set<string>();

    for (const startNode of this.graph.keys()) {
      this.dfs(startNode, startNode, [], [], visited, cycles);
      visited.add(startNode);
    }

    return cycles.filter(cycle => {
      if (cycle.nodes.length === 2) {
        return cycle.averageWeight >= this.config.symmetricRatingThreshold;
      }
      return cycle.averageWeight >= this.config.minCycleWeight;
    });
  }

  private dfs(
    startNode: string,
    currentNode: string,
    pathNodes: string[],
    pathEdges: RatingEdge[],
    globalVisited: Set<string>,
    cycles: Cycle[]
  ) {
    if (pathNodes.length >= this.config.maxCycleLength) {
      return;
    }

    pathNodes.push(currentNode);

    const edges = this.graph.get(currentNode) || [];
    for (const edge of edges) {
      const nextNode = edge.target;

      if (globalVisited.has(nextNode)) {
        continue;
      }

      const index = pathNodes.indexOf(nextNode);
      
      if (nextNode === startNode) {
        const cycleEdges = [...pathEdges, edge];
        const cycleNodes = [...pathNodes];
        
        const totalWeight = cycleEdges.reduce((sum, e) => sum + e.weight, 0);
        const averageWeight = totalWeight / cycleEdges.length;
        
        cycles.push({
          nodes: cycleNodes,
          edges: cycleEdges,
          averageWeight
        });
      } else if (index === -1) {
        pathEdges.push(edge);
        this.dfs(startNode, nextNode, pathNodes, pathEdges, globalVisited, cycles);
        pathEdges.pop();
      }
    }

    pathNodes.pop();
  }

  /**
   * Emits the detected cycles to a JSONL file for Human-In-The-Loop review.
   */
  async emitCaseFiles(outputDir: string, cycles: Cycle[]): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `collusion-cases-${timestamp}.jsonl`;
    const outputPath = path.join(outputDir, filename);

    await fs.mkdir(outputDir, { recursive: true });

    let content = '';
    for (const cycle of cycles) {
      content += JSON.stringify(cycle) + '\n';
    }

    if (content.length > 0) {
      await fs.writeFile(outputPath, content, 'utf8');
    } else {
      await fs.writeFile(outputPath, '', 'utf8');
    }
    
    return outputPath;
  }
}
