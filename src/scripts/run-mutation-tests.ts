import { execSync } from "node:child_process";
import path from "node:path";

const changedFiles = process.env.CHANGED_FILES || "";
const args = ["npx", "stryker", "run", "--config", "stryker.conf.json"];

if (changedFiles.trim()) {
  const files = changedFiles
    .split(/\s+/)
    .filter(Boolean)
    .map((file) => path.resolve(process.cwd(), file))
    .join(",");

  args.push("--files", files);
}

console.log(`Running Stryker with args: ${args.join(" ")}`);
execSync(args.join(" "), { stdio: "inherit", cwd: process.cwd() });
