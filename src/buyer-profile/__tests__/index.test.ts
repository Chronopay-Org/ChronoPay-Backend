/**
 * Contract coverage for the Buyer Profile barrel (src/buyer-profile/index.ts).
 *
 * The barrel is the module's public surface: it re-exports the service,
 * controller, router, DTO validators and types. These tests pin the re-export
 * wiring (identity with the source modules) plus one behavioural check that a
 * validator reached through the barrel still works.
 */

import * as barrel from "../index.js";
import {
  buyerProfileService,
  BuyerProfileService,
} from "../buyer-profile.service.js";
import {
  buyerProfileController,
  BuyerProfileController,
} from "../buyer-profile.controller.js";
import buyerProfileRoutes from "../buyer-profile.routes.js";
import {
  validateCreateBuyerProfile,
  validateUpdateBuyerProfile,
  validateUUID,
} from "../dto/buyer-profile.dto.js";

describe("buyer-profile barrel (index.ts)", () => {
  it("re-exports the service class and singleton as the same bindings", () => {
    expect(barrel.BuyerProfileService).toBe(BuyerProfileService);
    expect(barrel.buyerProfileService).toBe(buyerProfileService);
    expect(barrel.buyerProfileService).toBeInstanceOf(barrel.BuyerProfileService);
  });

  it("re-exports the controller class and singleton as the same bindings", () => {
    expect(barrel.BuyerProfileController).toBe(BuyerProfileController);
    expect(barrel.buyerProfileController).toBe(buyerProfileController);
    expect(barrel.buyerProfileController).toBeInstanceOf(barrel.BuyerProfileController);
  });

  it("re-exports the default router under a named `buyerProfileRoutes` binding", () => {
    expect(barrel.buyerProfileRoutes).toBe(buyerProfileRoutes);
    // An express Router is a callable function with routing methods.
    expect(typeof barrel.buyerProfileRoutes).toBe("function");
    expect(typeof (barrel.buyerProfileRoutes as any).use).toBe("function");
  });

  it("re-exports the DTO middleware used by the routes", () => {
    expect(barrel.validateCreateBuyerProfile).toBe(validateCreateBuyerProfile);
    expect(barrel.validateUpdateBuyerProfile).toBe(validateUpdateBuyerProfile);
    expect(barrel.validateUUID).toBe(validateUUID);
  });

  it("exposes a working DTO validator through the barrel", () => {
    const errors = barrel.validateCreateBuyerProfileDTO({
      fullName: "",
      email: "not-an-email",
    });

    expect(Array.isArray(errors)).toBe(true);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("fullName");
    expect(fields).toContain("email");
  });
});
