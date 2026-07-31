import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = [join(ROOT, "src", "agent"), join(ROOT, "src", "server")];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [fullPath] : [];
  });
}

function relativeSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers.filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"));
}

describe("packaged Node ESM imports", () => {
  it("uses explicit runtime extensions for every backend relative import", () => {
    const failures = [];
    for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of relativeSpecifiers(file, source)) {
        if (![".js", ".mjs", ".cjs", ".json"].includes(extname(specifier))) {
          failures.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], failures.join("\n"));
  });
});
