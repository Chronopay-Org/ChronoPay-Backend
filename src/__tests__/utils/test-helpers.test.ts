import { mockRequest, mockResponse, mockNext } from "../../utils/test-helpers.js";

describe("Test Helpers", () => {
  describe("mockRequest", () => {
    it("should return a default request object", () => {
      const req = mockRequest();
      expect(req.body).toEqual({});
      expect(req.params).toEqual({});
      expect(req.query).toEqual({});
    });

    it("should allow overriding defaults", () => {
      const req = mockRequest({ body: { name: "test" }, method: "POST" });
      expect(req.body).toEqual({ name: "test" });
      expect(req.method).toBe("POST");
    });
  });

  describe("mockResponse", () => {
    it("should handle status() and return itself for chaining", () => {
      const res = mockResponse();
      const result = res.status!(200);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(result).toBe(res);
    });

    it("should handle json() and return itself for chaining", () => {
      const res = mockResponse();
      const data = { success: true };
      const result = res.json!(data);
      expect(res.json).toHaveBeenCalledWith(data);
      expect(result).toBe(res);
    });

    it("should handle send() and return itself for chaining", () => {
      const res = mockResponse();
      const result = res.send!("hello");
      expect(res.send).toHaveBeenCalledWith("hello");
      expect(result).toBe(res);
    });

    it("should handle setHeader() and return itself for chaining", () => {
      const res = mockResponse();
      const result = res.setHeader!("Content-Type", "application/json");
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
      expect(result).toBe(res);
    });

    it("should have end() as a jest function", () => {
      const res = mockResponse();
      res.end!();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe("mockNext", () => {
    it("should return a callable jest function", () => {
      const next = mockNext();
      next();
      expect(next).toHaveBeenCalled();
    });
  });
});
