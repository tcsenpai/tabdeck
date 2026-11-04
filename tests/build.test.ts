import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createBuildId } from "../lib/build.ts";

describe("build id", () => {
  const mk = () => {
    const dir = mkdtempSync("/tmp/build-");
    writeFileSync(`${dir}/a.js`, "one");
    return dir;
  };
  test("short hex, stable while nothing changes", () => {
    const dir = mk();
    const id = createBuildId(dir, 0);
    expect(id()).toMatch(/^[0-9a-f]{7}$/);
    expect(id()).toBe(id());
  });
  test("changes when a file changes size or time, or a file appears", () => {
    const dir = mk();
    const id = createBuildId(dir, 0);
    const first = id();
    writeFileSync(`${dir}/a.js`, "two!");
    const second = id();
    expect(second).not.toBe(first);
    utimesSync(`${dir}/a.js`, 1, 1);
    const third = id();
    expect(third).not.toBe(second);
    writeFileSync(`${dir}/b.css`, "x");
    expect(id()).not.toBe(third);
  });
  test("cached within the ttl", () => {
    const dir = mk();
    const id = createBuildId(dir, 60_000);
    const first = id();
    writeFileSync(`${dir}/a.js`, "changed content");
    expect(id()).toBe(first);
  });
});
