import fs from "fs";
const file = "src/utils/jwt.ts";
const data = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, data.replace("} catch {", "} catch(e) { console.error('jwt error:', e);"));
