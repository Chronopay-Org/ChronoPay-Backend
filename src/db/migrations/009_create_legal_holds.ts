import { Pool } from "pg";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legal_holds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject_id VARCHAR(255) NOT NULL,
      actor VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      region VARCHAR(50) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    CREATE INDEX idx_legal_holds_subject_id ON legal_holds(subject_id);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS legal_holds;`);
}
