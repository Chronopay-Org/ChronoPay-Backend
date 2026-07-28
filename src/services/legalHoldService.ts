import { query } from "../db/pool.js";

export class LegalHoldService {
  static async addHold(subjectId: string, actor: string, reason: string, region: string = 'EEA'): Promise<void> {
    await query(
      `INSERT INTO legal_holds (subject_id, actor, reason, region) VALUES ($1, $2, $3, $4)`,
      [subjectId, actor, reason, region]
    );
  }

  static async isHeld(subjectId: string): Promise<boolean> {
    const res = await query(
      `SELECT 1 FROM legal_holds WHERE subject_id = $1 LIMIT 1`,
      [subjectId]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
