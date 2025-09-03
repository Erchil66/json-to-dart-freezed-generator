import React, { useMemo, useRef, useState } from "react";

/**
 * JSON → Dart (Freezed) Generator
 * --------------------------------------------------------------
 * • Generates null‑safe Dart data classes using the Freezed pattern
 * • Always adds @JsonKey(name: ...) annotations for each field
 * • Uses abstract classes as requested (old‑style @freezed abstract class)
 * • Infers nested classes, lists, maps, numbers, bool, DateTime
 * • Null‑safety by default (All fields nullable `?`), with optional Smart mode toggle
 * • Guarantees unique class names and unique Dart field names (deduplication)
 * • One‑click Copy and Download
 */

// ---------- Utilities ----------
const RESERVED_DART_WORDS = new Set([
  "abstract","else","import","super","as","enum","in","switch","assert","export","interface","sync","async","extends","is","this","await","extension","library","throw","break","external","mixin","true","case","factory","new","try","catch","false","null","typedef","class","final","on","var","const","finally","operator","void","continue","for","part","while","covariant","Function","rethrow","with","default","get","return","yield","deferred","hide","set","do","if","show","dynamic","implements","static"
]);

const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})([Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function toPascalCase(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!cleaned) return "ClassName";
  return cleaned
    .split(/\s+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("")
    .replace(/^[0-9]+/, (m) => `N${m}`);
}

function toCamelCase(input: string): string {
  const pas = toPascalCase(input);
  return pas.charAt(0).toLowerCase() + pas.slice(1);
}

function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function sanitizeFieldName(name: string): string {
  let n = toCamelCase(name);
  if (/^[0-9]/.test(n)) n = "v" + n; // prefix if starts with number
  if (RESERVED_DART_WORDS.has(n)) n = `${n}Value`;
  if (!n) n = "field";
  return n;
}

function sanitizeBaseClassName(name: string): string {
  let n = toPascalCase(name);
  if (RESERVED_DART_WORDS.has(n)) n = `${n}Type`;
  if (!n) n = "Model";
  return n;
}

function singularize(name: string): string {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, "y");
  if (/ses$/i.test(name)) return name.replace(/es$/i, "");
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.replace(/s$/i, "");
  return name;
}

function detectDateTime(s: string): boolean {
  return ISO_DATE_RE.test(s);
}

function analyzeNumberType(values: number[]): "int" | "double" {
  return values.some((v) => !Number.isInteger(v)) ? "double" : "int";
}

function isPlainObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// Unique name helpers
function makeUniqueName(base: string, used: Set<string>): string {
  let name = base;
  let i = 1;
  while (used.has(name)) {
    name = `${base}${i}`;
    i++;
  }
  used.add(name);
  return name;
}

// ---------- Type inference & class generation ----------

type FieldSpec = {
  nameOriginal: string;
  nameDart: string;
  dartType: string;
  nullable: boolean;
};

type ClassSpec = {
  name: string;
  fields: FieldSpec[];
};

type Options = {
  allNullable: boolean;
  abstractClass: boolean;
  includeFromToJson: boolean;
};

function generateClassesFromJson(
  jsonValue: any,
  rootNameRaw: string,
  opts: Options
): { code: string; classes: ClassSpec[]; warnings: string[] } {
  const classes = new Map<string, ClassSpec>();
  const warnings: string[] = [];
  const usedClassNames = new Set<string>();

  function uniqueClassName(base: string): string {
    const safeBase = sanitizeBaseClassName(base);
    return makeUniqueName(safeBase, usedClassNames);
  }

  function ensureClass(name: string): ClassSpec {
    if (!classes.has(name)) classes.set(name, { name, fields: [] });
    return classes.get(name)!;
  }

  function inferTypeForArray(arr: any[], keyHint: string, ownerClass: string): { dart: string; nestedClass?: string } {
    if (arr.length === 0) return { dart: "List<dynamic>" };
    const nonNulls = arr.filter((v) => v !== null && v !== undefined);
    if (nonNulls.length === 0) return { dart: "List<dynamic>" };

    // All objects → merge to a child class
    if (nonNulls.every((v) => isPlainObject(v))) {
      const childName = uniqueClassName(toPascalCase(singularize(keyHint)) || `${ownerClass}Item`);
      const child = ensureClass(childName);
      const usedFieldNames = new Set<string>();

      // Merge fields from all objects (union of keys)
      const unionKeys = new Set<string>();
      for (const o of nonNulls) for (const k of Object.keys(o)) unionKeys.add(k);
      for (const k of unionKeys) {
        // Take a representative value (first one that has it)
        const v = (nonNulls.find((o) => k in o) as any)[k];
        child.fields.push(inferFieldSpec(k, v, childName, usedFieldNames));
      }

      return { dart: `List<${childName}>`, nestedClass: childName };
    }

    // Homogeneous primitives
    if (nonNulls.every((v) => typeof v === "string")) {
      const maybeDate = nonNulls.every((s) => typeof s === "string" && detectDateTime(s));
      return { dart: maybeDate ? "List<DateTime>" : "List<String>" };
    }
    if (nonNulls.every((v) => typeof v === "number")) {
      const kind = analyzeNumberType(nonNulls as number[]);
      return { dart: `List<${kind}>` };
    }
    if (nonNulls.every((v) => typeof v === "boolean")) return { dart: "List<bool>" };

    return { dart: "List<dynamic>" };
  }

  function inferFieldSpec(
    originalKey: string,
    value: any,
    ownerClassName: string,
    usedFieldNames: Set<string>
  ): FieldSpec {
    const baseName = sanitizeFieldName(originalKey);
    const uniqueFieldName = makeUniqueName(baseName, usedFieldNames);

    let dartType = "dynamic";
    let nullable = true; // default to nullable; explicit non-null only in Smart mode

    if (!opts.allNullable) {
      nullable = value === null || value === undefined; // Smart mode sets non-null when value is present
    }

    if (value === null || value === undefined) {
      dartType = "dynamic";
    } else if (Array.isArray(value)) {
      const { dart } = inferTypeForArray(value, originalKey, ownerClassName);
      dartType = dart;
    } else if (isPlainObject(value)) {
      const childName = uniqueClassName(toPascalCase(originalKey) || `${ownerClassName}Child`);
      const child = ensureClass(childName);
      const usedChildFields = new Set<string>();
      for (const [k, v] of Object.entries(value)) {
        child.fields.push(inferFieldSpec(k, v, childName, usedChildFields));
      }
      dartType = childName;
    } else {
      switch (typeof value) {
        case "string":
          dartType = detectDateTime(value) ? "DateTime" : "String";
          break;
        case "number":
          dartType = Number.isInteger(value) ? "int" : "double";
          break;
        case "boolean":
          dartType = "bool";
          break;
        default:
          dartType = "dynamic";
      }
    }

    // Force nullable when All Nullable mode is on
    if (opts.allNullable) nullable = true;

    return { nameOriginal: originalKey, nameDart: uniqueFieldName, dartType, nullable };
  }

  function processRoot(value: any, rootName: string) {
    const root = ensureClass(rootName);
    const used = new Set<string>();

    if (Array.isArray(value)) {
      warnings.push("Top-level JSON is an array; generated a wrapper model with a single list field.");
      const { dart } = inferTypeForArray(value, singularize(rootName), rootName);
      root.fields.push({
        nameOriginal: toCamelCase(singularize(rootName)),
        nameDart: makeUniqueName(toCamelCase(singularize(rootName)), used),
        dartType: dart,
        nullable: true,
      });
    } else if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        root.fields.push(inferFieldSpec(k, v, rootName, used));
      }
    } else {
      warnings.push("Top-level JSON is a primitive; wrapping as a single dynamic field.");
      root.fields.push({ nameOriginal: "value", nameDart: makeUniqueName("value", used), dartType: "dynamic", nullable: true });
    }
  }

  const rootName = uniqueClassName(rootNameRaw);
  processRoot(jsonValue, rootName);

  // Build Dart code
  const fileBase = toSnakeCase(rootName);

  const header = `// Generated by JSON → Dart (Freezed) Generator
// ignore_for_file: invalid_annotation_target
import 'package:freezed_annotation/freezed_annotation.dart';

part '${fileBase}.freezed.dart';
part '${fileBase}.g.dart';
`;

  const classBlocks: string[] = [];

  for (const cls of classes.values()) {
    const params = cls.fields
      .map((f) => `    @JsonKey(name: '${f.nameOriginal}') ${f.dartType}${f.nullable ? "?" : ""} ${f.nameDart},`)
      .join("\n");

    const ctor = `  const factory ${cls.name}({
${params}
  }) = _${cls.name};`;

    const jsonFactory = opts.includeFromToJson
      ? `

  factory ${cls.name}.fromJson(Map<String, Object?> json) => _$${cls.name}FromJson(json);`
      : "";

    const block = `@freezed
abstract class ${cls.name} with _\$${cls.name} {
${ctor}${jsonFactory}
}`;
    classBlocks.push(block);
  }

  return { code: [header, ...classBlocks].join("\n\n"), classes: Array.from(classes.values()), warnings };
}

// ---------- React UI ----------

type Mode = "smart" | "all_nullable";

export default function App() {
  const [jsonText, setJsonText] = useState<string>(`{
  "id": 123,
  "name": "Jane Doe",
  "email_address": "jane@example.com",
  "is_active": true,
  "score": 9.75,
  "created_at": "2024-12-31T10:15:30Z",
  "tags": ["pro", "vip"],
  "preferences": {
    "theme": "dark",
    "notifications": {
      "email": true,
      "sms": null
    }
  },
  "friends": [
    { "id": 1, "name": "Alice" },
    { "id": 2, "name": "Bob" }
  ],
  "name": "Duplicate Field"
}`);
  const [rootName, setRootName] = useState<string>("UserModel");
  const [mode, setMode] = useState<Mode>("all_nullable");
  const [includeJson, setIncludeJson] = useState<boolean>(true);
  const [abstractClass] = useState<boolean>(true); // fixed true per request
  const [error, setError] = useState<string | null>(null);

  const opts: Options = useMemo(
    () => ({ allNullable: mode === "all_nullable", abstractClass, includeFromToJson: includeJson }),
    [mode, abstractClass, includeJson]
  );

  const result = useMemo(() => {
    try {
      setError(null);
      const parsed = JSON.parse(jsonText);
      return generateClassesFromJson(parsed, sanitizeBaseClassName(rootName || "Model"), opts);
    } catch (e: any) {
      setError(e?.message || "Invalid JSON");
      return { code: "", classes: [], warnings: [] };
    }
  }, [jsonText, rootName, opts]);

  const codeRef = useRef<HTMLPreElement>(null);

  function copyToClipboard() {
    navigator.clipboard.writeText(result.code).catch(() => {
      const sel = window.getSelection();
      const range = document.createRange();
      if (codeRef.current) {
        range.selectNodeContents(codeRef.current);
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("copy");
        sel?.removeAllRanges();
      }
    });
  }

  function downloadFile() {
    const base = toSnakeCase(rootName || "model");
    const blob = new Blob([result.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.dart";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">JSON → Dart (Freezed) Generator</h1>
          <div className="flex gap-2">
            <button onClick={copyToClipboard} className="rounded-2xl px-4 py-2 bg-gray-900 text-white shadow hover:opacity-90">Copy</button>
            <button onClick={downloadFile} className="rounded-2xl px-4 py-2 bg-white ring-1 ring-gray-300 shadow-sm hover:bg-gray-100">Download .dart</button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <section className="bg-white rounded-2xl shadow p-4 md:p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
              <label className="font-medium">Input JSON</label>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm">Nullability</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as Mode)}
                    className="rounded-xl border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="all_nullable">All nullable (?)</option>
                    <option value="smart">Smart (infer)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input id="incljson" type="checkbox" checked={includeJson} onChange={(e) => setIncludeJson(e.target.checked)} />
                  <label htmlFor="incljson" className="text-sm">include fromJson/toJson</label>
                </div>
                <div className="flex items-center gap-2 opacity-70">
                  <input id="abstract" type="checkbox" checked readOnly />
                  <label htmlFor="abstract" className="text-sm">abstract class</label>
                </div>
              </div>
            </div>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              className="w-full h-80 md:h-[28rem] font-mono text-sm rounded-xl border border-gray-300 p-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              placeholder="Paste your JSON here..."
            />
            {error && (
              <p className="mt-2 text-sm text-red-600">{error}</p>
            )}
            {!error && result.warnings.length > 0 && (
              <ul className="mt-2 text-sm text-amber-700 list-disc pl-5">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-white rounded-2xl shadow p-4 md:p-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <label className="font-medium" htmlFor="root">Root class</label>
                <input
                  id="root"
                  value={rootName}
                  onChange={(e) => setRootName(e.target.value)}
                  className="rounded-xl border border-gray-300 px-3 py-1 text-sm"
                  placeholder="UserModel"
                />
              </div>
              <div className="text-xs text-gray-500">Adds <code>@JsonKey</code> to every field • Freezed + json_serializable</div>
            </div>

            <pre ref={codeRef} className="h-80 md:h-[28rem] overflow-auto rounded-xl border border-gray-300 p-3 bg-gray-950 text-gray-100 text-xs leading-relaxed">
{result.code}
            </pre>
          </section>
        </div>

        <footer className="mt-6 text-sm text-gray-600">
          <p>
            File names in <code>part</code> lines are derived from the root class (e.g., <code>{toSnakeCase(rootName)}.freezed.dart</code> and <code>{toSnakeCase(rootName)}.g.dart</code>). If you rename the file, update those lines accordingly.
          </p>
          <p className="mt-2">After saving, run <code>flutter pub run build_runner build --delete-conflicting-outputs</code>.</p>
        </footer>
      </div>
    </div>
  );
}
