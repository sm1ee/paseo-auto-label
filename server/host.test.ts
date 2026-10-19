import { describe, expect, it } from "vitest";
import { belongsToDaemon, collectPages, localEndpoint } from "./host";

describe("host adapter", () => {
  it("accepts its direct daemon or desktop supervisor and rejects unrelated processes", async () => {
    expect(await belongsToDaemon(100, 100, async () => 1)).toBe(true);
    expect(await belongsToDaemon(101, 100, async (pid) => { expect(pid).toBe(101); return 100; })).toBe(true);
    expect(await belongsToDaemon(200, 100, async () => 201)).toBe(false);
    expect(await belongsToDaemon(200, 100, async () => { throw new Error("no process"); })).toBe(false);
  });
  it("reads later directory pages", async () => {
    const result = await collectPages({ entries: ["first"], pageInfo: { hasMore: true, nextCursor: "page-2" } }, async (cursor) => {
      expect(cursor).toBe("page-2");
      return { entries: ["second"], pageInfo: { hasMore: false, nextCursor: null } };
    });
    expect(result).toEqual(["first", "second"]);
  });
  it("rejects missing and repeated pagination cursors", async () => {
    await expect(collectPages({ entries: [], pageInfo: { hasMore: true, nextCursor: null } }, async () => { throw new Error("unused"); })).rejects.toThrow("invalid directory cursor");
    await expect(collectPages({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } }, async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } }))).rejects.toThrow("invalid directory cursor");
  });
  it("uses loopback for wildcard listeners and supports local sockets", () => {
    expect(localEndpoint("0.0.0.0:1234").url).toBe("ws://127.0.0.1:1234/ws");
    expect(localEndpoint("[::]:1234").url).toBe("ws://[::1]:1234/ws");
    expect(localEndpoint("unix:///tmp/example.sock").socketPath).toBe("/tmp/example.sock");
  });
  it("refuses to send local credentials to another machine or a URL with credentials", () => {
    for (const endpoint of ["example.test:1234", "192.0.2.10:1234", "secret@localhost:1234", "localhost:1234/another-path"]) expect(() => localEndpoint(endpoint)).toThrow();
  });
});
