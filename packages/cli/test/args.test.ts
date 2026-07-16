import { describe, expect, it } from "vitest";
import { parseArgs, flagString } from "../src/args.js";

describe("parseArgs", () => {
  it("parses --flag=value", () => {
    expect(parseArgs(["--target=standalone"]).flags.target).toBe("standalone");
  });
  it("parses --flag value", () => {
    expect(parseArgs(["--out", "dir"]).flags.out).toBe("dir");
  });
  it("treats known booleans and value-less flags as true", () => {
    expect(parseArgs(["--help"]).flags.help).toBe(true);
    expect(parseArgs(["--version"]).flags.version).toBe(true);
    expect(parseArgs(["--all"]).flags.all).toBe(true);
    expect(parseArgs(["validate", "--fix"]).flags.fix).toBe(true);
  });
  it("collects positionals in order", () => {
    expect(parseArgs(["compile", "x.yaml"]).positionals).toEqual(["compile", "x.yaml"]);
  });
  it("handles a comma target list as a string value", () => {
    expect(parseArgs(["--target", "standalone,babysitter"]).flags.target).toBe("standalone,babysitter");
  });
  it("flagString returns undefined for boolean flags", () => {
    expect(flagString({ help: true }, "help")).toBeUndefined();
    expect(flagString({ out: "d" }, "out")).toBe("d");
  });
});
