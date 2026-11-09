/**
 * Issue #22 guard: the checkout tab must be opened synchronously inside the
 * click gesture. Any `await` (or other async hop) placed before the tab is
 * opened makes browsers block the popup again. The behavioural tests in
 * entitlement.test.ts cover runCheckout(); this one is a static lint over the
 * real source so a refactor of startCheckout() cannot slip an await in front
 * of runCheckout() either.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const FILE = join(process.cwd(), "src/lib/entitlement.ts");
const source = ts.createSourceFile(
  FILE,
  readFileSync(FILE, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

type Fn = ts.FunctionLikeDeclaration;

function findFunction(name: string): Fn {
  let found: Fn | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      found = node;
    // const startCheckout = useCallback(async (...) => { ... }, [...])
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const init = node.initializer;
      const fn =
        ts.isCallExpression(init) &&
        init.arguments[0] &&
        ts.isArrowFunction(init.arguments[0])
          ? init.arguments[0]
          : ts.isArrowFunction(init) || ts.isFunctionExpression(init)
            ? init
            : undefined;
      if (fn) found = fn;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`function ${name} not found in entitlement.ts`);
  return found;
}

/** Positions of async hops (await, .then/.catch/.finally, for-await) in a function body. */
function asyncHops(fn: Fn): number[] {
  const hops: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isAwaitExpression(node)) hops.push(node.getStart());
    if (ts.isForOfStatement(node) && node.awaitModifier)
      hops.push(node.getStart());
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["then", "catch", "finally"].includes(node.expression.name.text)
    ) {
      hops.push(node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return hops;
}

/** Start of the first call to `callee` that is a direct statement-level call in the body. */
function firstCall(fn: Fn, callee: string): number {
  let pos = -1;
  const visit = (node: ts.Node) => {
    if (pos >= 0) return;
    // Do not accept a call hidden inside a nested callback (it would not run synchronously).
    if (
      node !== fn &&
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    )
      return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      pos = node.getStart();
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return pos;
}

describe("#22 guard: no async hop before the checkout tab opens", () => {
  test("runCheckout opens the tab before its first await", () => {
    const fn = findFunction("runCheckout");
    const open = firstCall(fn, "openCheckoutTab");
    expect(
      open,
      "runCheckout must call openCheckoutTab synchronously",
    ).toBeGreaterThanOrEqual(0);
    const hops = asyncHops(fn);
    expect(hops.length).toBeGreaterThan(0); // sanity: the fetch is awaited
    expect(Math.min(...hops)).toBeGreaterThan(open);
  });

  test("startCheckout calls runCheckout before any await", () => {
    const fn = findFunction("startCheckout");
    const call = firstCall(fn, "runCheckout");
    expect(
      call,
      "startCheckout must call runCheckout synchronously",
    ).toBeGreaterThanOrEqual(0);
    for (const hop of asyncHops(fn)) expect(hop).toBeGreaterThan(call);
  });

  test("the guard itself catches an await placed before the open (self-test)", () => {
    const bad = ts.createSourceFile(
      "bad.ts",
      `export async function runCheckout() { await Promise.resolve(); openCheckoutTab(); await x(); }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = bad.statements[0] as ts.FunctionDeclaration;
    const openPos = (() => {
      let p = -1;
      const v = (n: ts.Node) => {
        if (
          p < 0 &&
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "openCheckoutTab"
        )
          p = n.getStart();
        ts.forEachChild(n, v);
      };
      v(fn);
      return p;
    })();
    expect(Math.min(...asyncHops(fn))).toBeLessThan(openPos);
  });
});
