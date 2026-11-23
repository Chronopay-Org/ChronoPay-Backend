// @ts-nocheck
import fs from 'fs/promises';
import path from 'path';
import { CollusionAnalyzer } from '../services/collusionAnalyzer';

describe('CollusionAnalyzer', () => {
  it('should detect a simple 3-node cycle above threshold', () => {
    const analyzer = new CollusionAnalyzer({ minCycleWeight: 3.0 });
    analyzer.addRating('A', 'B', 5);
    analyzer.addRating('B', 'C', 4);
    analyzer.addRating('C', 'A', 5);

    const cycles = analyzer.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toEqual(['A', 'B', 'C']);
    expect(cycles[0].averageWeight).toBeCloseTo((5 + 4 + 5) / 3);
  });

  it('should ignore cycles below the minimum weight threshold', () => {
    const analyzer = new CollusionAnalyzer({ minCycleWeight: 4.0 });
    analyzer.addRating('A', 'B', 3);
    analyzer.addRating('B', 'C', 3);
    analyzer.addRating('C', 'A', 3);

    const cycles = analyzer.detectCycles();
    expect(cycles).toHaveLength(0);
  });

  it('should correctly handle symmetric ratings (2-node cycles) based on symmetric threshold', () => {
    const analyzer = new CollusionAnalyzer({ 
      minCycleWeight: 3.0,
      symmetricRatingThreshold: 4.5
    });

    // Valid symmetric below threshold (false positive prevention)
    analyzer.addRating('A', 'B', 4);
    analyzer.addRating('B', 'A', 4);

    // Collusion symmetric above threshold
    analyzer.addRating('C', 'D', 5);
    analyzer.addRating('D', 'C', 5);

    const cycles = analyzer.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toEqual(['C', 'D']);
  });

  it('should handle sparse graphs efficiently and find no cycles', () => {
    const analyzer = new CollusionAnalyzer();
    // A -> B -> C -> D (No cycle)
    analyzer.addRating('A', 'B', 5);
    analyzer.addRating('B', 'C', 5);
    analyzer.addRating('C', 'D', 5);
    
    // E -> F (No cycle)
    analyzer.addRating('E', 'F', 5);

    const cycles = analyzer.detectCycles();
    expect(cycles).toHaveLength(0);
  });

  it('should not blow up on a giant SCC, limited by maxCycleLength', () => {
    const analyzer = new CollusionAnalyzer({ maxCycleLength: 3 });

    // Create a fully connected graph of 6 nodes (giant SCC)
    const nodes = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'];
    for (const n1 of nodes) {
      for (const n2 of nodes) {
        if (n1 !== n2) {
          analyzer.addRating(n1, n2, 5);
        }
      }
    }

    const cycles = analyzer.detectCycles();
    
    expect(cycles.length).toBeGreaterThan(0);
    for (const cycle of cycles) {
      expect(cycle.nodes.length).toBeLessThanOrEqual(3);
    }
  });

  it('should emit case files correctly', async () => {
    const analyzer = new CollusionAnalyzer();
    analyzer.addRating('A', 'B', 5);
    analyzer.addRating('B', 'A', 5);

    const cycles = analyzer.detectCycles();
    
    const outputDir = path.join(process.cwd(), 'src', '__tests__', 'test-output');
    const outputPath = await analyzer.emitCaseFiles(outputDir, cycles);
    
    const content = await fs.readFile(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    
    const parsed = JSON.parse(lines[0]);
    expect(parsed.nodes).toEqual(['A', 'B']);
    
    // Clean up
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('should emit empty case file when no cycles detected', async () => {
    const analyzer = new CollusionAnalyzer();
    const outputDir = path.join(process.cwd(), 'src', '__tests__', 'test-output-empty');
    const outputPath = await analyzer.emitCaseFiles(outputDir, []);
    
    const content = await fs.readFile(outputPath, 'utf8');
    expect(content).toBe('');
    
    // Clean up
    await fs.rm(outputDir, { recursive: true, force: true });
  });
});
