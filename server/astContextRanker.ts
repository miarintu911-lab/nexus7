import fs from 'fs/promises';
import path from 'path';
import { transformSync } from 'esbuild';
import * as acorn from 'acorn';

export interface AstSymbolInfo {
  kind: 'function' | 'component' | 'class' | 'interface' | 'type' | 'const' | 'route';
  name: string;
  signature: string;
  line: number;
  exported: boolean;
}

export interface AstFileSummary {
  file: string;
  lines: number;
  rawChars: number;
  score: number;
  imports: string[];
  symbols: AstSymbolInfo[];
  calls: string[];
}

export interface AstRankedContextResult {
  query: string;
  root: string;
  totalFilesScanned: number;
  rawChars: number;
  compactChars: number;
  tokenSavingsPercent: number;
  rankedFiles: AstFileSummary[];
  formattedContext: string;
}

function formatParams(params: any[] = []): string {
  return params
    .slice(0, 6)
    .map((p) => {
      if (!p) return 'arg';
      if (p.type === 'Identifier') return p.name;
      if (p.type === 'ObjectPattern') return '{...}';
      if (p.type === 'ArrayPattern') return '[...]';
      if (p.type === 'AssignmentPattern' && p.left?.name) return `${p.left.name}=`;
      if (p.type === 'RestElement' && p.argument?.name) return `...${p.argument.name}`;
      return 'arg';
    })
    .join(', ');
}

function collectCallsFromNode(node: any, out: Set<string>, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 28 || out.size >= 25) return;
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (callee?.type === 'Identifier') {
      out.add(callee.name);
    } else if (
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.property?.type === 'Identifier'
    ) {
      out.add(`${callee.object.name}.${callee.property.name}`);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) collectCallsFromNode(item, out, depth + 1);
    } else if (val && typeof val === 'object' && val.type) {
      collectCallsFromNode(val, out, depth + 1);
    }
  }
}

export function extractAstSymbols(code: string, ext: string = '.tsx'): {
  imports: string[];
  symbols: AstSymbolInfo[];
  calls: string[];
  usedAst: boolean;
} {
  const imports: string[] = [];
  const symbols: AstSymbolInfo[] = [];
  const callsSet = new Set<string>();

  // 1. Extract TypeScript interfaces & type aliases directly with original line numbers
  const rawLines = code.split('\n');
  rawLines.forEach((lineStr, idx) => {
    const ifaceMatch = lineStr.match(/^\s*(export\s+)?interface\s+([A-Za-z0-9_]+)/);
    if (ifaceMatch) {
      symbols.push({
        kind: 'interface',
        name: ifaceMatch[2],
        signature: `interface ${ifaceMatch[2]}`,
        line: idx + 1,
        exported: Boolean(ifaceMatch[1]),
      });
    }
    const typeMatch = lineStr.match(/^\s*(export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
    if (typeMatch) {
      symbols.push({
        kind: 'type',
        name: typeMatch[2],
        signature: `type ${typeMatch[2]}`,
        line: idx + 1,
        exported: Boolean(typeMatch[1]),
      });
    }
  });

  // 2. Transpile TS/TSX -> clean ESM JS via esbuild & parse AST via Acorn
  try {
    const loader = ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : ext === '.js' || ext === '.mjs' ? 'js' : 'tsx';
    const transformed = transformSync(code, {
      loader,
      jsx: 'transform',
      format: 'esm',
      target: 'es2022',
    });

    const ast: any = acorn.parse(transformed.code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });

    // Helper to map symbol back to original TS line number if possible
    const findOrigLine = (name: string, fallbackLine: number): number => {
      const idx = rawLines.findIndex(
        (l) =>
          l.includes(`function ${name}`) ||
          l.includes(`class ${name}`) ||
          l.includes(`const ${name}`) ||
          l.includes(`let ${name}`) ||
          l.includes(`export { ${name}`)
      );
      return idx >= 0 ? idx + 1 : fallbackLine;
    };

    const visitTopNode = (node: any, exported: boolean) => {
      if (!node) return;
      const fallbackLine = node.loc?.start?.line || 1;

      if (node.type === 'ImportDeclaration' && node.source?.value) {
        imports.push(String(node.source.value));
        return;
      }

      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) visitTopNode(node.declaration, true);
        if (Array.isArray(node.specifiers)) {
          for (const spec of node.specifiers) {
            if (spec.exported?.name) {
              symbols.push({
                kind: 'const',
                name: spec.exported.name,
                signature: `export { ${spec.exported.name} }`,
                line: findOrigLine(spec.exported.name, fallbackLine),
                exported: true,
              });
            }
          }
        }
        return;
      }

      if (node.type === 'ExportDefaultDeclaration') {
        if (node.declaration) visitTopNode(node.declaration, true);
        return;
      }

      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        const name = node.id.name;
        const isComp = /^[A-Z]/.test(name);
        symbols.push({
          kind: isComp ? 'component' : 'function',
          name,
          signature: `${node.async ? 'async ' : ''}function ${name}(${formatParams(node.params)})`,
          line: findOrigLine(name, fallbackLine),
          exported,
        });
        return;
      }

      if (node.type === 'ClassDeclaration' && node.id?.name) {
        const methods = (node.body?.body || [])
          .filter((m: any) => m.type === 'MethodDefinition' && m.key?.name)
          .slice(0, 8)
          .map((m: any) => m.key.name);
        symbols.push({
          kind: 'class',
          name: node.id.name,
          signature: `class ${node.id.name} { ${methods.join(', ')} }`,
          line: findOrigLine(node.id.name, fallbackLine),
          exported,
        });
        return;
      }

      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations || []) {
          const idName = decl.id?.name;
          if (!idName) continue;
          const init = decl.init;
          if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
            const isComp = /^[A-Z]/.test(idName);
            symbols.push({
              kind: isComp ? 'component' : 'function',
              name: idName,
              signature: `${idName}(${formatParams(init.params)}) => ...`,
              line: findOrigLine(idName, fallbackLine),
              exported,
            });
          } else if (exported) {
            symbols.push({
              kind: 'const',
              name: idName,
              signature: `const ${idName}`,
              line: findOrigLine(idName, fallbackLine),
              exported,
            });
          }
        }
      }
    };

    for (const stmt of ast.body || []) {
      visitTopNode(stmt, false);
    }

    // Also extract Express route endpoints
    const routeRe = /\bapp\.(get|post|put|delete|patch|all|use)\(\s*(['"`])([^'"`]+)\2/g;
    let rm: RegExpExecArray | null;
    while ((rm = routeRe.exec(code)) !== null) {
      const lineNum = code.slice(0, rm.index).split('\n').length;
      symbols.push({
        kind: 'route',
        name: rm[3],
        signature: `app.${rm[1]}('${rm[3]}')`,
        line: lineNum,
        exported: false,
      });
    }

    collectCallsFromNode(ast, callsSet);
    return {
      imports: Array.from(new Set(imports)).slice(0, 15),
      symbols: symbols.slice(0, 35),
      calls: Array.from(callsSet).slice(0, 20),
      usedAst: true,
    };
  } catch {
    rawLines.forEach((l, idx) => {
      const m = l.match(/^\s*(export\s+)?(?:async\s+)?(function|class)\s+([A-Za-z0-9_]+)/);
      if (m) {
        symbols.push({
          kind: m[2] === 'class' ? 'class' : 'function',
          name: m[3],
          signature: l.trim().slice(0, 80),
          line: idx + 1,
          exported: Boolean(m[1]),
        });
      }
    });
    return { imports, symbols, calls: [], usedAst: false };
  }
}

export async function rankAstContext(
  query: string = '',
  targetDir: string = '.',
  topK: number = 10
): Promise<AstRankedContextResult> {
  const cwd = process.cwd();
  const rootAbs = path.resolve(cwd, targetDir.replace(/^[/\\]+/, '') || '.');
  const filePaths: string[] = [];

  const walk = async (dir: string, depth = 0) => {
    if (depth > 4 || filePaths.length >= 90) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'dev-dist', '.nexus_checkpoints', 'public', '.nexus_plans', 'workspaces'].includes(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name)) {
        filePaths.push(full);
      }
    }
  };

  await walk(rootAbs);

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);

  let rawChars = 0;
  const summaries: AstFileSummary[] = [];

  for (const abs of filePaths) {
    const code = await fs.readFile(abs, 'utf-8').catch(() => '');
    if (!code) continue;
    rawChars += code.length;
    const rel = path.relative(cwd, abs);
    const { imports, symbols, calls } = extractAstSymbols(code, path.extname(abs));

    let score = 1;
    const relLower = rel.toLowerCase();
    for (const term of terms) {
      if (relLower.includes(term)) score += 6;
      for (const sym of symbols) {
        if (sym.name.toLowerCase() === term) score += 12;
        else if (sym.name.toLowerCase().includes(term) || sym.signature.toLowerCase().includes(term)) score += 5;
      }
      for (const call of calls) {
        if (call.toLowerCase().includes(term)) score += 3;
      }
      for (const imp of imports) {
        if (imp.toLowerCase().includes(term)) score += 2;
      }
    }
    if (rel === 'server.ts' || rel === 'src/App.tsx') score += 2;
    score += Math.min(4, Math.floor(symbols.filter((s) => s.exported).length / 2));

    summaries.push({
      file: rel,
      lines: code.split('\n').length,
      rawChars: code.length,
      score,
      imports,
      symbols,
      calls,
    });
  }

  summaries.sort((a, b) => b.score - a.score || a.lines - b.lines);
  const rankedFiles = summaries.slice(0, Math.max(1, Math.min(topK, 20)));

  const formattedLines = rankedFiles.map((f) => {
    const syms = f.symbols
      .slice(0, 12)
      .map((s) => `  L${s.line}: ${s.exported ? 'export ' : ''}${s.signature}`)
      .join('\n');
    const callsStr = f.calls.length > 0 ? `  Calls: ${f.calls.slice(0, 10).join(', ')}` : '';
    return `• ${f.file} (${f.lines}L, score=${f.score})\n${syms || '  (no top-level symbols)'}${callsStr ? `\n${callsStr}` : ''}`;
  });

  const formattedContext = `[AST RANKED CODEBASE CONTEXT - Top ${rankedFiles.length}/${summaries.length} files]\n${formattedLines.join('\n\n')}`;
  const compactChars = formattedContext.length;
  const tokenSavingsPercent = rawChars > 0 ? Math.max(0, Math.min(99, Math.round((1 - compactChars / rawChars) * 100))) : 0;

  return {
    query,
    root: targetDir,
    totalFilesScanned: summaries.length,
    rawChars,
    compactChars,
    tokenSavingsPercent,
    rankedFiles,
    formattedContext,
  };
}
