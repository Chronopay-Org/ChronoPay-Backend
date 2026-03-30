import fs from "fs/promises";
import path from "path";

export interface AuditLogEntry {
  timestamp: string;
  action: string;
  actorIp?: string;
  resource?: string;
  status: string | number;
  metadata?: Record<string, any>;
}

export class AuditLogger {
  private logFilePath: string;

  constructor(filePath?: string) {
    // Default to 'logs/audit.log' in project root
    this.logFilePath = filePath || path.join(process.cwd(), "logs", "audit.log");
  }

  /**
   * Appends an audit log entry to the JSONL file.
   * Resolves asynchronously and does not throw errors if writing fails.
   */
  public async log(entry: Omit<AuditLogEntry, "timestamp">): Promise<void> {
    const logData: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
      await fs.appendFile(this.logFilePath, JSON.stringify(logData) + "\n", "utf8");
    } catch (error) {
      // Failure mode handling: We log to console rather than breaking the application flow
      console.error("Failed to write to audit log:", error);
    }
  }
}

// Export a default singleton instance for use across the application
export const defaultAuditLogger = new AuditLogger();
