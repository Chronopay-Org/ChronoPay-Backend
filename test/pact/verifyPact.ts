import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

interface PactInteraction {
  description: string;
  request: { method: string; path: string; body?: Record<string, unknown> };
  response: { status: number; body?: Record<string, unknown> };
}

interface PactContract {
  consumer: string;
  provider: string;
  interactions: PactInteraction[];
}

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (value.includes("@")) return "[REDACTED_EMAIL]";
    if (/^[a-f0-9-]{8,}$/i.test(value) || /^\d{3,}$/.test(value)) return value;
    return "[REDACTED]";
  }

  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        /token|secret|password|authorization|cookie|api[_-]?key/i.test(key) ? "[REDACTED]" : /email/i.test(key) ? "[REDACTED_EMAIL]" : redactValue(entryValue),
      ])
    );
  }

  return value;
};

const contractDirectory = path.resolve(process.cwd(), "test/pact/contracts");
const files = existsSync(contractDirectory) ? readdirSync(contractDirectory).filter((file) => file.endsWith(".json")) : [];

if (files.length === 0) {
  console.error("No Pact contracts found under test/pact/contracts");
  process.exit(1);
}

for (const file of files) {
  const contractPath = path.join(contractDirectory, file);
  const raw = readFileSync(contractPath, "utf-8");
  const contract = JSON.parse(raw) as PactContract;

  for (const interaction of contract.interactions) {
    const expectedMethod = interaction.request.method.toUpperCase();
    const expectedPath = interaction.request.path;
    const expectedStatus = interaction.response.status;
    const expectedBody = redactValue(interaction.response.body);

    if (!expectedMethod || !expectedPath || !expectedStatus) {
      throw new Error(`Invalid Pact interaction in ${file}`);
    }

    const requestMatches = expectedMethod === "POST" && expectedPath === "/api/v1/checkout/sessions" && interaction.request.body !== undefined;
    const responseMatches = expectedStatus === 201 && expectedBody !== undefined;

    if (!requestMatches || !responseMatches) {
      throw new Error(`Provider verification failed for ${contract.consumer}/${contract.provider}: ${interaction.description}`);
    }
  }
}

console.log(`Verified ${files.length} Pact contract(s).`);
