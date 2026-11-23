export interface ChaosResult {
  experimentId: string;
  timestamp: number;
  remediationTicketUrl: string | null;
  status: 'SUCCESS' | 'FAILED' | 'ERROR';
  details: string;
}

export class ChaosStore {
  private results: Map<string, ChaosResult> = new Map();

  constructor() {}

  public save(result: ChaosResult): void {
    if (!result.experimentId) {
      throw new Error('Experiment ID is required');
    }
    if (this.results.has(result.experimentId)) {
      throw new Error('Duplicate experiment ID');
    }
    // ensure shallow copy to prevent mutation outside
    this.results.set(result.experimentId, { ...result });
  }

  public get(experimentId: string): ChaosResult | undefined {
    const result = this.results.get(experimentId);
    return result ? { ...result } : undefined;
  }

  public getAll(): ChaosResult[] {
    return Array.from(this.results.values()).map(r => ({ ...r }));
  }

  public query(options: { 
    status?: 'SUCCESS' | 'FAILED' | 'ERROR';
    since?: number;
    until?: number;
    hasTicket?: boolean;
  }): ChaosResult[] {
    let filtered = this.getAll();
    if (options.status) {
      filtered = filtered.filter(r => r.status === options.status);
    }
    if (options.since !== undefined) {
      filtered = filtered.filter(r => r.timestamp >= options.since!);
    }
    if (options.until !== undefined) {
      filtered = filtered.filter(r => r.timestamp <= options.until!);
    }
    if (options.hasTicket !== undefined) {
      filtered = filtered.filter(r => options.hasTicket ? !!r.remediationTicketUrl : !r.remediationTicketUrl);
    }
    return filtered;
  }

  // Cover edge case: Ticket deleted
  public removeTicket(experimentId: string): void {
    const result = this.results.get(experimentId);
    if (!result) throw new Error('Not found');
    result.remediationTicketUrl = null;
    this.results.set(experimentId, result);
  }

  // Cover edge case: Ancient results
  public purgeAncient(cutoffTimestamp: number): number {
    let count = 0;
    for (const [id, result] of this.results.entries()) {
      if (result.timestamp < cutoffTimestamp) {
        this.results.delete(id);
        count++;
      }
    }
    return count;
  }

  public generateQuarterlyReport(year: number, quarter: 1 | 2 | 3 | 4): string {
    const startMonth = (quarter - 1) * 3;
    const startDate = new Date(year, startMonth, 1).getTime();
    const endDate = new Date(year, startMonth + 3, 0, 23, 59, 59, 999).getTime();

    const results = this.query({ since: startDate, until: endDate });

    let report = `## Chaos Results Report - Q${quarter} ${year}\n\n`;
    report += `Total Experiments: ${results.length}\n`;
    
    const successes = results.filter(r => r.status === 'SUCCESS').length;
    const failures = results.filter(r => r.status === 'FAILED').length;
    const errors = results.filter(r => r.status === 'ERROR').length;
    
    report += `- Success: ${successes}\n`;
    report += `- Failed: ${failures}\n`;
    report += `- Error: ${errors}\n\n`;

    report += `### Details\n`;
    for (const r of results) {
      const ticketInfo = r.remediationTicketUrl ? `[Ticket](${r.remediationTicketUrl})` : 'No ticket';
      report += `- ${new Date(r.timestamp).toISOString()} | ${r.experimentId} | ${r.status} | ${ticketInfo}\n`;
    }

    return report;
  }
}
