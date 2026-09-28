import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { migrations } from "../migrations/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Migration Registry", () => {
  it("contains unique migration IDs without duplicates", () => {
    const ids = migrations.map((m) => m.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it("exposes valid id, name, up, and down functions for each migration", () => {
    for (const m of migrations) {
      expect(typeof m.id).toBe("string");
      expect(m.id.trim()).not.toBe("");

      expect(typeof m.name).toBe("string");
      expect(m.name.trim()).not.toBe("");

      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
    }
  });

  it("registers migrations in ascending alphanumeric order", () => {
    const ids = migrations.map((m) => m.id);
    const sortedIds = [...ids].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
    expect(ids).toEqual(sortedIds);
  });

  it("matches registered migrations to actual files on disk in src/db/migrations", () => {
    const migrationsDir = path.resolve(__dirname, "../migrations");
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".ts") && f !== "index.ts");

    for (const m of migrations) {
      const matchingFile = files.find(
        (f) => f.startsWith(`${m.id}_`) || f.startsWith(m.id.replace(/[a-z]$/, "") + "_") || f.includes(m.name)
      );
      expect(matchingFile).toBeDefined();
    }
  });
});
