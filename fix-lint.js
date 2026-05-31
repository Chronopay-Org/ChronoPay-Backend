 
import { execSync } from "child_process";

// eslint-disable-next-line unused-imports/no-unused-vars
const output = execSync("npx eslint . --format json", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
// Wait, eslint returns non-zero if there are errors, so execSync will throw.
