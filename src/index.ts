import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { ContractService } from "./services/contract.service.js";

const config = loadEnvConfig();
const horizonContractService = new ContractService();
const app = createApp({
  enableDocs: true,
  enableTestRoutes: config.nodeEnv !== "production",
  horizonContractService,
});

const PORT = config.port || 3001;
const server = app.listen(PORT, () => {
  console.log(`ChronoPay API listening on http://localhost:${PORT}`);
});

export default server;
