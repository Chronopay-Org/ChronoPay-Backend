import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import { parseCookies } from "../cookieParser.js";

const app = express();
app.use(parseCookies);
app.get("/cookies", (req, res) => res.json(req.cookies));

describe("unsigned cookie parsing", () => {
  it.each([
    ["bad=%E0%A4%A; ok=1", { bad: "%E0%A4%A", ok: "1" }],
    ["t=YWJj==; expression=a=b=c", { t: "YWJj==", expression: "a=b=c" }],
    ['quoted="a=b=="; text="hello%20world"', { quoted: "a=b==", text: "hello world" }],
    ["x=first; x=second", { x: "first" }],
    ["x=; x=second", { x: "" }],
    ["=ignore;   =ignore; orphan; ok = yes", { ok: "yes" }],
    ["x=%; y=%FF; z=%2520", { x: "%", y: "%FF", z: "%20" }],
    ["x=a%3Bb%3Dc", { x: "a;b=c" }],
  ])("parses %s without losing or overwriting values", async (header, expected) => {
    const response = await request(app).get("/cookies").set("Cookie", header);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expected);
  });

  it("keeps encoded OAuth PKCE JSON and state intact", async () => {
    const pkce = JSON.stringify({ verifier: "abc==", created: 123 });
    const response = await request(app)
      .get("/cookies")
      .set("Cookie", `oauth2_pkce=${encodeURIComponent(pkce)}; oauth2_state=state%3Dvalue`);
    expect(response.body.oauth2_pkce).toBe(pkce);
    expect(JSON.parse(response.body.oauth2_pkce).verifier).toBe("abc==");
    expect(response.body.oauth2_state).toBe("state=value");
  });

  it("treats inherited property names as ordinary cookie keys", async () => {
    const response = await request(app)
      .get("/cookies")
      .set("Cookie", "__proto__=first; __proto__=second; constructor=value");
    expect(Object.hasOwn(response.body, "__proto__")).toBe(true);
    expect(response.body["__proto__"]).toBe("first");
    expect(response.body.constructor).toBe("value");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("starts each request with an independent, empty cookie collection", async () => {
    await request(app).get("/cookies").set("Cookie", "previous=1");
    expect((await request(app).get("/cookies")).body).toEqual({});
  });
});
