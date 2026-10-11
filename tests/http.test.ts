import { describe, expect, it } from "vitest";
import { ApiError, unwrap } from "../src/client/http.js";

describe("ApiResponse envelope", () => {
  it("returns the payload of a successful call", () => {
    expect(unwrap<{ id: string }>({ success: true, data: { id: "s1" } }, "read survey")).toEqual({ id: "s1" });
  });

  it("passes through a null payload, as the void endpoints return", () => {
    expect(unwrap<null>({ success: true, data: null }, "delete survey")).toBeNull();
  });

  it("throws a typed error carrying the backend code", () => {
    try {
      unwrap({ success: false, error: { code: "NOT_ARCHIVED", message: "Survey is not archived" } }, "delete", 400);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("NOT_ARCHIVED");
      expect((error as ApiError).status).toBe(400);
    }
  });

  it("appends an actionable hint to the codes a caller can do something about", () => {
    const attempt = () =>
      unwrap({ success: false, error: { code: "QUOTA_EXCEEDED", message: "Quota exceeded" } }, "publish", 403);
    expect(attempt).toThrow(/quota/i);
    expect(attempt).toThrow(/feedbay_whoami/);
  });

  it("names the failing operation so the message stands on its own", () => {
    expect(() => unwrap({ success: false, error: { message: "boom" } }, "publish survey")).toThrow(
      /publish survey: boom/,
    );
  });

  it("rejects a body that is not an envelope rather than returning undefined", () => {
    expect(() => unwrap({ url: "https://cdn/x.png" }, "upload image")).toThrow(/not an ApiResponse envelope/);
    expect(() => unwrap("nope", "read survey")).toThrow(/non-object response/);
  });
});
