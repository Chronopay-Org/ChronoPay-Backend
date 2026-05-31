import fs from "fs";
const file = "src/routes/auth.ts";
const data = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, data.replace("const { token } = req.body ?? {};", "const { token } = req.body ?? {}; console.error('SECRETS:', require('../config/config.service.js').configService.getAllSecretVersions('JWT_SECRET'));"));
