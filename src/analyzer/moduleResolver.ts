import fs from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";

/** Resolution options come from config; included files still come from our walker. */
export function createModuleResolver(rootDir: string) {
  const root = path.resolve(rootDir);
  const optionsByDirectory = new Map<string, ts.CompilerOptions>();
  const optionsByConfig = new Map<string, ts.CompilerOptions>();
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };

  function optionsFor(directory: string): ts.CompilerOptions {
    const cached = optionsByDirectory.get(directory);
    if (cached) return cached;
    const config = ["tsconfig.json", "jsconfig.json"]
      .map((name) => path.join(directory, name))
      .find((file) => fs.existsSync(file));
    let options: ts.CompilerOptions;
    if (config) {
      const existing = optionsByConfig.get(config);
      if (existing) options = existing;
      else {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, {
          ...ts.sys,
          // Loading compiler options must not scan excluded project/dependency files.
          readDirectory: () => [],
        }, directory);
        const errors = [read.error, ...parsed.errors]
          .filter((error): error is ts.Diagnostic => !!error && error.code !== 18003 && error.code !== 18002);
        if (errors.length) {
          const message = errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n");
          throw new Error(`Cannot read ${config}: ${message}`);
        }
        options = { ...defaults, ...parsed.options };
        optionsByConfig.set(config, options);
      }
    } else {
      options = directory === root ? defaults : optionsFor(path.dirname(directory));
    }
    optionsByDirectory.set(directory, options);
    return options;
  }

  const resolve = (specifier: string, fromFile: string): string | undefined => {
    const options = optionsFor(path.dirname(fromFile));
    const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys).resolvedModule;
    if (resolved) return path.resolve(resolved.resolvedFileName);
    // Preserve the analyzer's original permissive extensionless .mjs/.cjs
    // support, which TypeScript's Node resolver deliberately does not probe.
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      const base = path.resolve(path.dirname(fromFile), specifier);
      for (const candidate of [base + ".mjs", base + ".cjs", path.join(base, "index.mjs"), path.join(base, "index.cjs")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
    return undefined;
  };
  return Object.assign(resolve, {
    validateFile(fromFile: string) { optionsFor(path.dirname(fromFile)); },
  });
}
