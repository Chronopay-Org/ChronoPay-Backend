import { signJwt, verifyJwt } from "./src/utils/jwt.js";
import { configService } from "./src/config/config.service.js";

async function test() {
  process.env.JWT_SECRET = "primary-secret-key-12345";
  process.env.JWT_SECRET_PREV = "retired-secret-key-67890";
  process.env.JWT_ISSUER = "test-issuer";
  process.env.JWT_AUDIENCE = "test-audience";
  configService.refresh();
  
  const token = await signJwt({ sub: "user-123" }, "primary-secret-key-12345", { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" });
  console.log("Token:", token);
  
  try {
    const payload = await verifyJwt(token);
    console.log("Payload:", payload);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
