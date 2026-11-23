import type { QueryResult } from "pg";
import { query as defaultQuery } from "../../db/pool.js";
import {
  DiscountCurveAlreadyExistsError,
  type DiscountCurveFilters,
  type DiscountCurveRecord,
  type DiscountCurveRepository,
} from "./discount-curve-repository.js";

type QueryFn = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult<Record<string, unknown>>>;

export class PgDiscountCurveRepository implements DiscountCurveRepository {
  constructor(private readonly dbQuery: QueryFn = defaultQuery) {}

  async create(curve: DiscountCurveRecord): Promise<DiscountCurveRecord> {
    const sql = `
      INSERT INTO discount_curves (
        id, name, description, supplier_id, bundle_id, tiers, stackability,
        active, valid_from, valid_until, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
        $8, $9, $10, $11, $12
      )
      RETURNING *
    `;

    try {
      const result = await this.dbQuery(sql, [
        curve.id,
        curve.name,
        curve.description ?? null,
        curve.supplierId,
        curve.bundleId,
        JSON.stringify(curve.tiers),
        JSON.stringify(curve.stackability),
        curve.active,
        curve.validFrom ?? null,
        curve.validUntil ?? null,
        new Date(curve.createdAt),
        new Date(curve.updatedAt),
      ]);
      return this.mapRow(result.rows[0]);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new DiscountCurveAlreadyExistsError(curve.id);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<DiscountCurveRecord | undefined> {
    const result = await this.dbQuery(
      `SELECT * FROM discount_curves WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : undefined;
  }

  async list(
    filters: DiscountCurveFilters = {},
  ): Promise<DiscountCurveRecord[]> {
    const result = await this.dbQuery(
      `
        SELECT * FROM discount_curves
        WHERE ($1::text IS NULL OR supplier_id = $1)
          AND ($2::text IS NULL OR bundle_id = $2)
          AND ($3::boolean IS NULL OR active = $3)
        ORDER BY created_at ASC, id ASC
      `,
      [filters.supplierId ?? null, filters.bundleId ?? null, filters.active ?? null],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async update(
    id: string,
    curve: DiscountCurveRecord,
  ): Promise<DiscountCurveRecord | undefined> {
    const result = await this.dbQuery(
      `
        UPDATE discount_curves
        SET name = $2,
            description = $3,
            supplier_id = $4,
            bundle_id = $5,
            tiers = $6::jsonb,
            stackability = $7::jsonb,
            active = $8,
            valid_from = $9,
            valid_until = $10,
            updated_at = $11
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        curve.name,
        curve.description ?? null,
        curve.supplierId,
        curve.bundleId,
        JSON.stringify(curve.tiers),
        JSON.stringify(curve.stackability),
        curve.active,
        curve.validFrom ?? null,
        curve.validUntil ?? null,
        new Date(curve.updatedAt),
      ],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.dbQuery(
      `DELETE FROM discount_curves WHERE id = $1`,
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  private mapRow(row: Record<string, unknown>): DiscountCurveRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      ...(row.description == null
        ? {}
        : { description: String(row.description) }),
      supplierId: String(row.supplier_id),
      bundleId: String(row.bundle_id),
      tiers: this.parseJson(row.tiers) as DiscountCurveRecord["tiers"],
      stackability: this.parseJson(
        row.stackability,
      ) as DiscountCurveRecord["stackability"],
      active: Boolean(row.active),
      ...(row.valid_from == null ? {} : { validFrom: Number(row.valid_from) }),
      ...(row.valid_until == null
        ? {}
        : { validUntil: Number(row.valid_until) }),
      createdAt: new Date(row.created_at as string | Date).getTime(),
      updatedAt: new Date(row.updated_at as string | Date).getTime(),
    };
  }

  private parseJson(value: unknown): unknown {
    return typeof value === "string" ? JSON.parse(value) : value;
  }
}

export const defaultDiscountCurveRepository = new PgDiscountCurveRepository();
