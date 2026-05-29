import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";

const config = loadEnvConfig();
const app = createApp({
  enableDocs: true,
  enableTestRoutes: config.nodeEnv !== "production",
});

const PORT = config.port || 3001;
const server = app.listen(PORT, () => {
  console.log(`ChronoPay API listening on http://localhost:${PORT}`);
});

export default server;
