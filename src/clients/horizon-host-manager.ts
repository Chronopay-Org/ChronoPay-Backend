import { horizonHostHealth, horizonFailoverTotal } from "../metrics.js";
import { HorizonUnavailableError } from "../errors/contractErrors.js";
import { shouldRetryContractError } from "../errors/contractErrors.js";

const QUARANTINE_COOLDOWN_MS = 15000;
const ERROR_WINDOW_MS = 10000;
const MAX_ERRORS = 3;
const PROBE_TIMEOUT_MS = 5000;

interface HostStatus {
  url: string;
  isPrimary: boolean;
  isQuarantined: boolean;
  quarantinedAt: number;
  errorTimestamps: number[];
  lastSuccessAt: number;
}

export class HorizonHostManager {
  private hosts: HostStatus[];
  private currentHostIndex: number = 0;

  constructor(urls: string[]) {
    if (!urls || urls.length === 0) {
      throw new Error("HorizonHostManager requires at least one URL");
    }
    
    this.hosts = urls.map((u, i) => ({
      url: u.replace(/\/$/, ""),
      isPrimary: i === 0,
      isQuarantined: false,
      quarantinedAt: 0,
      errorTimestamps: [],
      lastSuccessAt: 0,
    }));
    
    this.updateHealthMetrics();
  }

  private updateHealthMetrics() {
    for (const host of this.hosts) {
      horizonHostHealth.labels(host.url).set(host.isQuarantined ? 0 : 1);
    }
  }

  public async getHealthyHost(): Promise<string> {
    const now = Date.now();
    
    // Recovery probes
    for (const host of this.hosts) {
      if (host.isQuarantined && now - host.quarantinedAt >= QUARANTINE_COOLDOWN_MS) {
        const recovered = await this.probeHost(host);
        if (recovered) {
          host.isQuarantined = false;
          host.errorTimestamps = [];
          host.lastSuccessAt = now;
          if (host.isPrimary) {
             // Sticky primary recovery
             this.currentHostIndex = 0;
          }
          this.updateHealthMetrics();
        } else {
          // Reset quarantine timer
          host.quarantinedAt = now;
        }
      }
    }

    // Try primary first if it's healthy
    const primary = this.hosts[0];
    if (!primary.isQuarantined) {
      if (this.currentHostIndex !== 0) {
        this.currentHostIndex = 0;
      }
      return primary.url;
    }

    // Otherwise find first healthy fallback
    for (let i = 1; i < this.hosts.length; i++) {
      if (!this.hosts[i].isQuarantined) {
        if (this.currentHostIndex !== i) {
          horizonFailoverTotal.inc();
          this.currentHostIndex = i;
        }
        return this.hosts[i].url;
      }
    }

    throw new HorizonUnavailableError();
  }

  public recordSuccess(url: string) {
    const host = this.hosts.find(h => h.url === url);
    if (host) {
      host.lastSuccessAt = Date.now();
      if (host.isQuarantined) {
        host.isQuarantined = false;
        host.errorTimestamps = [];
        this.updateHealthMetrics();
      }
    }
  }

  public recordError(url: string, error: unknown) {
    if (!shouldRetryContractError(error)) {
       return; // don't quarantine for 4xx errors
    }

    const host = this.hosts.find(h => h.url === url);
    if (!host || host.isQuarantined) return;

    const now = Date.now();
    host.errorTimestamps.push(now);
    
    // Clean old errors
    host.errorTimestamps = host.errorTimestamps.filter(t => now - t <= ERROR_WINDOW_MS);

    if (host.errorTimestamps.length >= MAX_ERRORS) {
      host.isQuarantined = true;
      host.quarantinedAt = now;
      this.updateHealthMetrics();
      
      // If primary was quarantined, failover might happen next call
    }
  }

  private async probeHost(host: HostStatus): Promise<boolean> {
    try {
      // Deterministic recovery probe using root endpoint or ledgers
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await fetch(`${host.url}/ledgers?limit=1`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}
