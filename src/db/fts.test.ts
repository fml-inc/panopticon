import { describe, expect, it } from "vitest";
import { buildSafeFtsQuery, tokenizeSearchTerms } from "./fts.js";

describe("tokenizeSearchTerms", () => {
  it("extracts words from a normal query", () => {
    expect(tokenizeSearchTerms("hello world")).toEqual(["hello", "world"]);
  });

  it("lowercases all tokens", () => {
    expect(tokenizeSearchTerms("Hello WORLD FooBar")).toEqual([
      "hello",
      "world",
      "foobar",
    ]);
  });

  it("deduplicates identical tokens", () => {
    expect(tokenizeSearchTerms("error error error")).toEqual(["error"]);
  });

  it("deduplicates after lowercasing", () => {
    expect(tokenizeSearchTerms("Error ERROR error")).toEqual(["error"]);
  });

  it("filters tokens shorter than default minLength (3)", () => {
    expect(tokenizeSearchTerms("a b cd")).toEqual([]);
  });

  it("keeps tokens exactly at minLength", () => {
    expect(tokenizeSearchTerms("abc")).toEqual(["abc"]);
  });

  it("respects custom minLength parameter", () => {
    expect(tokenizeSearchTerms("a bb ccc dddd", 2)).toEqual([
      "bb",
      "ccc",
      "dddd",
    ]);
  });

  it("respects minLength=1 to keep single chars", () => {
    expect(tokenizeSearchTerms("a b c", 1)).toEqual(["a", "b", "c"]);
  });

  it("strips punctuation", () => {
    expect(tokenizeSearchTerms("hello, world!")).toEqual(["hello", "world"]);
  });

  it("strips colons, semicolons, dashes, and brackets", () => {
    expect(tokenizeSearchTerms("fix: [bug] -- done;")).toEqual([
      "fix",
      "bug",
      "done",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeSearchTerms("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(tokenizeSearchTerms("   \t\n  ")).toEqual([]);
  });

  it("includes numeric tokens", () => {
    expect(tokenizeSearchTerms("error 404")).toEqual(["error", "404"]);
  });

  it("keeps mixed alphanumeric tokens intact", () => {
    expect(tokenizeSearchTerms("v2beta abc123")).toEqual(["v2beta", "abc123"]);
  });

  it("strips unicode and special characters, keeping only a-z0-9 runs", () => {
    // The regex [a-z0-9]+ splits on non-matching chars;
    // "na" and "ve" from "naïve" are < 3 chars so get filtered by default minLength
    expect(tokenizeSearchTerms("café naïve über")).toEqual(["caf", "ber"]);
  });

  it("keeps short unicode fragments with lower minLength", () => {
    expect(tokenizeSearchTerms("café naïve über", 2)).toEqual([
      "caf",
      "na",
      "ve",
      "ber",
    ]);
  });

  it("strips quotes, parens, and asterisks", () => {
    expect(tokenizeSearchTerms('"hello" (world) foo*')).toEqual([
      "hello",
      "world",
      "foo",
    ]);
  });

  it("handles a very long input", () => {
    const long = "word ".repeat(1000).trim();
    const result = tokenizeSearchTerms(long);
    // All 1000 occurrences of "word" collapse to one unique token
    expect(result).toEqual(["word"]);
  });

  it("handles input with only short tokens returning empty", () => {
    expect(tokenizeSearchTerms("if do go")).toEqual([]);
  });

  it("preserves order of first occurrence", () => {
    const result = tokenizeSearchTerms("delta alpha beta alpha delta");
    expect(result).toEqual(["delta", "alpha", "beta"]);
  });
});

describe("buildSafeFtsQuery", () => {
  it("joins multiple words with AND", () => {
    expect(buildSafeFtsQuery("hello world")).toBe("hello AND world");
  });

  it("returns a single word as-is", () => {
    expect(buildSafeFtsQuery("error")).toBe("error");
  });

  it("returns null for short tokens below minLength 3", () => {
    expect(buildSafeFtsQuery("a b")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(buildSafeFtsQuery("")).toBeNull();
  });

  it("returns null for punctuation-only input", () => {
    expect(buildSafeFtsQuery("!@#$%^&*()")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(buildSafeFtsQuery("   ")).toBeNull();
  });

  it("filters short words and joins remaining", () => {
    expect(buildSafeFtsQuery("a big old if test")).toBe("big AND old AND test");
  });

  it("strips FTS-unsafe characters like quotes and parens", () => {
    // Quotes/parens are stripped; "AND" in the input becomes the token "and"
    // which is 3 chars and survives filtering
    expect(buildSafeFtsQuery('"hello" AND (world)')).toBe(
      "hello AND and AND world",
    );
  });

  it("strips FTS-unsafe chars from simple input", () => {
    // Without the literal "AND" in the input, just quotes/parens
    expect(buildSafeFtsQuery('"hello" (world)')).toBe("hello AND world");
  });

  it("strips asterisks used for FTS prefix queries", () => {
    expect(buildSafeFtsQuery("test* foo*")).toBe("test AND foo");
  });

  it("handles real-world commit-style query", () => {
    expect(buildSafeFtsQuery("fix: SQL injection bug")).toBe(
      "fix AND sql AND injection AND bug",
    );
  });

  it("handles real-world error query", () => {
    expect(buildSafeFtsQuery("SQLITE_BUSY retry logic")).toBe(
      "sqlite AND busy AND retry AND logic",
    );
  });

  it("deduplicates before joining", () => {
    expect(buildSafeFtsQuery("error error handling")).toBe(
      "error AND handling",
    );
  });

  it("lowercases the output", () => {
    const result = buildSafeFtsQuery("Hello WORLD");
    expect(result).toBe("hello AND world");
  });
});
