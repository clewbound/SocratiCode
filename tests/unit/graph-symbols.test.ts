// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import {
  extractSymbolsAndCalls,
  rawCallsToUnresolvedEdges,
} from "../../src/services/graph-symbols.js";

beforeAll(() => {
  ensureDynamicLanguages();
});

describe("graph-symbols", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts function declarations and synthesizes a <module> symbol", () => {
      const src = `
function foo() { return 1; }
function bar() { return foo(); }
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/a.ts");
      const names = out.symbols.map((s) => s.name).sort();
      expect(names).toContain("<module>");
      expect(names).toContain("foo");
      expect(names).toContain("bar");
    });

    it("attributes calls inside a function to that function as caller", () => {
      const src = `
function foo() {}
function bar() { foo(); }
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/b.ts");
      const fooCall = out.rawCalls.find((c) => c.calleeName === "foo");
      expect(fooCall).toBeDefined();
      expect(fooCall?.callerId).toContain("::bar#");
    });

    it("extracts class methods with qualified names", () => {
      const src = `
class Foo {
  bar() { return 1; }
  baz() { return this.bar(); }
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/c.ts");
      const qnames = out.symbols.map((s) => s.qualifiedName);
      expect(qnames).toContain("Foo.bar");
      expect(qnames).toContain("Foo.baz");
      const kinds = out.symbols.filter((s) => s.qualifiedName === "Foo.bar").map((s) => s.kind);
      expect(kinds).toContain("method");
    });

    it("extracts arrow function constants", () => {
      const src = `
export const validate = (x: number) => x > 0;
const helper = function () { return 42; };
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/d.ts");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("validate");
      expect(names).toContain("helper");
    });
  });

  describe("Python", () => {
    it("extracts def and class symbols", () => {
      const src = `
def foo():
    return 1

class Bar:
    def baz(self):
        return foo()
`;
      const out = extractSymbolsAndCalls(src, "python" as unknown as Lang, ".py", "app.py");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("foo");
      expect(names).toContain("Bar");
      expect(names).toContain("baz");
    });
  });

  describe("Go", () => {
    it("extracts func declarations", () => {
      const src = `
package main

func Foo() int { return 1 }

func Bar() int { return Foo() }
`;
      const out = extractSymbolsAndCalls(src, "go" as unknown as Lang, ".go", "main.go");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).toContain("Bar");
    });
  });

  describe("rawCallsToUnresolvedEdges", () => {
    it("converts raw calls to unresolved SymbolEdge objects", () => {
      const raw = [
        {
          callerId: "src/a.ts::foo#1",
          calleeName: "bar",
          callSite: { file: "src/a.ts", line: 5 },
        },
      ];
      const edges = rawCallsToUnresolvedEdges(raw);
      expect(edges).toHaveLength(1);
      expect(edges[0].confidence).toBe("unresolved");
      expect(edges[0].calleeCandidates).toEqual([]);
      expect(edges[0].calleeName).toBe("bar");
    });
  });
});
