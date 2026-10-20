// Converts JSDoc types in .ts files (just renamed from .js) to TypeScript annotations, using
// TypeScript 5's code fixes, which TypeScript 7 lacks. Once: `npm install --prefix scripts/jsdoc`.
// Then: `node scripts/jsdoc/jsdocToTs.ts <file.ts>...` from the repo root.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const FIX_IDS = ['convertTypedefToType', 'annotateWithTypeFromJSDoc'];

const files = process.argv.slice(2).map((f) => path.resolve(f));
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const versions = new Map(files.map((f) => [f, 0]));

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists)!;
const { options } = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  path.dirname(configPath),
);

const service = ts.createLanguageService({
  getScriptFileNames: () => files,
  getScriptVersion: (f) => String(versions.get(f) ?? 0),
  getScriptSnapshot: (f) => {
    const text = texts.get(f) ?? ts.sys.readFile(f);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => options,
  getDefaultLibFileName: ts.getDefaultLibFilePath,
  fileExists: (f) => texts.has(f) || ts.sys.fileExists(f),
  readFile: (f) => texts.get(f) ?? ts.sys.readFile(f),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});

function applyEdits(text: string, edits: readonly ts.TextChange[]): string {
  for (const { span, newText } of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, span.start) + newText + text.slice(span.start + span.length);
  }
  return text;
}

function closing(text: string, open: number): number {
  const [o, c] = text[open] === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  return -1;
}

function convertCasts(text: string): string {
  const cast = /\/\*\*\s*@type\s*(?=\{)/g;
  let out = '';
  let from = 0;
  for (let m = cast.exec(text); m; m = cast.exec(text)) {
    const typeOpen = m.index + m[0].length;
    const typeClose = closing(text, typeOpen);
    const rest = /^\s*\*\/\s*(?=\()/.exec(text.slice(typeClose + 1));
    if (typeClose < 0 || !rest) continue;
    const exprOpen = typeClose + 1 + rest[0].length;
    const exprClose = closing(text, exprOpen);
    if (exprClose < 0) continue;
    const type = text.slice(typeOpen + 1, typeClose).trim();
    const expr = text.slice(exprOpen + 1, exprClose).trim();
    const before = text.slice(from, m.index);
    const after = text.slice(exprClose + 1);
    const whole =
      (/(?:=|\breturn)\s*$/.test(before) && /^\s*;/.test(after)) || (/[(,]\s*$/.test(before) && /^\s*[),]/.test(after));
    out += `${before}${whole ? `${expr} as ${type}` : `(${expr} as ${type})`}`;
    from = exprClose + 1;
    cast.lastIndex = from;
  }
  return out + text.slice(from);
}

function stripTypeBraces(text: string): string {
  const tag = /@(?:param|returns?|type)\s*(?=\{)/g;
  let out = '';
  let from = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const open = m.index + m[0].length;
    const close = closing(text, open);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + 1;
    while (text[from] === ' ') from++;
    tag.lastIndex = from;
  }
  return out + text.slice(from);
}

function hoistTypeImports(text: string): string {
  const byModule = new Map<string, Set<string>>();
  const use = (mod: string, name: string) => byModule.set(mod, (byModule.get(mod) ?? new Set()).add(name));
  text = text
    .replace(/^type (\w+) = import\('([^']+)'\)\.\1;\n/gm, (_, name: string, mod: string) => {
      use(mod, name);
      return '';
    })
    .replace(/(?<!await )import\('([^']+)'\)\.(\w+)/g, (_, mod: string, name: string) => {
      use(mod, name);
      return name;
    });
  if (byModule.size === 0) return text;
  const lines = [...byModule].map(([mod, names]) => `import type { ${[...names].join(', ')} } from '${mod}';\n`);
  const imports = [...text.matchAll(/^import [^;]*;\n/gm)];
  const header = /^\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n\n/.exec(text);
  const at = imports.length > 0 ? imports.at(-1)!.index! + imports.at(-1)![0].length : header ? header[0].length : 0;
  const rest = text.slice(at);
  const after = imports.length > 0 ? rest.replace(/^\n{2,}/, '\n') : `\n${rest.replace(/^\n+/, '')}`;
  return text.slice(0, at) + lines.join('') + after;
}

function isOptionalParam(param: ts.ParameterDeclaration): boolean {
  if (param.initializer || param.questionToken || param.dotDotDotToken) return true;
  return ts.getJSDocParameterTags(param).some(
    (tag) => tag.isBracketed || tag.typeExpression?.type.kind === ts.SyntaxKind.JSDocOptionalType,
  );
}

function markOptionalParams(file: string, text: string): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: ts.TextChange[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      const params = node.parameters;
      params.forEach((param, i) => {
        const bare = !param.initializer && !param.questionToken && !param.dotDotDotToken;
        if (bare && isOptionalParam(param) && params.slice(i + 1).every(isOptionalParam)) {
          edits.push({ span: { start: param.name.end, length: 0 }, newText: '?' });
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return applyEdits(text, edits);
}

function propertyDocs(file: string, text: string): Map<string, Map<string, string>> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const docs = new Map<string, Map<string, string>>();
  const visit = (node: ts.Node) => {
    if (ts.isJSDocTypedefTag(node) && node.name && node.typeExpression && ts.isJSDocTypeLiteral(node.typeExpression)) {
      const props = new Map<string, string>();
      for (const tag of node.typeExpression.jsDocPropertyTags ?? []) {
        const comment = ts.getTextOfJSDocComment(tag.comment)?.trim();
        if (comment) props.set(tag.name.getText(source), comment);
      }
      docs.set(node.name.text, props);
    }
    ts.forEachChild(node, visit);
  };
  const walk = (node: ts.Node) => {
    for (const doc of (node as { jsDoc?: ts.JSDoc[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return docs;
}

function interfacesToTypes(file: string, text: string, docs: Map<string, Map<string, string>>): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: ts.TextChange[] = [];
  for (const node of source.statements) {
    if (!ts.isInterfaceDeclaration(node) || node.heritageClauses || !docs.has(node.name.text)) continue;
    const start = node.getStart(source);
    const brace = text.indexOf('{', node.name.end);
    edits.push({ span: { start, length: brace - start }, newText: `export type ${node.name.text} = ` });
    for (const member of node.members) {
      const comment = member.name && docs.get(node.name.text)!.get(member.name.getText(source));
      if (!comment) continue;
      const at = member.getStart(source);
      const indent = text.slice(text.lastIndexOf('\n', at) + 1, at);
      edits.push({ span: { start: at, length: 0 }, newText: `/** ${comment} */\n${indent}` });
    }
    edits.push({ span: { start: node.end, length: 0 }, newText: ';' });
  }
  return applyEdits(text, edits);
}

function stripJsDocTypes(text: string): string {
  return hoistTypeImports(stripTypeBraces(text))
    .replace(/(@returns?)[ \t]*\n[ \t]*\*[ \t]{2,}(?=[^\s@*\/])/g, '$1 ')
    .replace(/^[ \t]*\*[ \t]*@(?:param|returns?|type)[ \t]*(?:\[[\w.$]+(?:=[^\]]*)?\]|[\w.$]+)?[ \t]*\n(?![ \t]*\*[ \t]{2,}[^\s@*/])/gm, '')
    .replace(/[ \t]*\/\*\*[ \t]*@(?:param|returns?|type)[ \t]*(?:[\w.$]+)?[ \t]*\*\/[ \t]*\n/g, '')
    .replace(/\/\*\*[ \t]*@(?:param|returns?|type)[ \t]*(?:[\w.$]+)?[ \t]*\*\/[ \t]*/g, '')
    .replace(/@param[ \t]+[\w.$]+[ \t]+(?=@)/g, '')
    .replace(/[ \t]*@returns?[ \t]*(?=\*\/)/g, ' ')
    .replace(/^[ \t]*\/\*\*[ \t]*\*\/[ \t]*\n/gm, '')
    .replace(/(@param[ \t]+)\[([\w.$]+)\]/g, '$1$2')
    .replace(/^[ \t]*\*[ \t]*\n(?=[ \t]*\*\/)/gm, '')
    .replace(/^[ \t]*\/\*\*(?:[ \t]*\n[ \t]*\*)*[ \t]*\/\n/gm, '')
    .replace(/^export \{\};\n/m, '')
    .replace(/^type (?=\w+ =)/gm, 'export type ');
}

for (const file of files) texts.set(file, convertCasts(texts.get(file)!));
const docs = new Map(files.map((f) => [f, propertyDocs(f, texts.get(f)!)]));
for (const file of files) texts.set(file, markOptionalParams(file, texts.get(file)!));

for (const fixId of FIX_IDS) {
  for (const file of files) {
    const { changes } = service.getCombinedCodeFix(
      { type: 'file', fileName: file },
      fixId,
      { ...ts.getDefaultFormatCodeSettings('\n'), indentSize: 2, tabSize: 2 },
      { quotePreference: 'single' },
    );
    const edits = changes
      .filter((c) => c.fileName === file)
      .flatMap((c) => c.textChanges)
      .map((e) => ({ ...e, newText: e.newText.replace(/;\s*\}/g, (m) => (m.includes('\n') ? m : ' }')) }));
    if (edits.length === 0) continue;
    texts.set(file, applyEdits(texts.get(file)!, edits));
    versions.set(file, versions.get(file)! + 1);
  }
}

for (const file of files) {
  const text = stripJsDocTypes(interfacesToTypes(file, texts.get(file)!, docs.get(file)!));
  if (text !== readFileSync(file, 'utf8')) {
    writeFileSync(file, text);
    console.log(`converted ${path.relative(process.cwd(), file)}`);
  }
}
