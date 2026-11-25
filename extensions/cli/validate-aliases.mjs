// Run with node (package.json build:validate). No hashbang: with CRLF line
// endings (a Windows checkout) vitest can't strip it when a test imports this.
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Import CLI logger for consistent logging
let logger;
try {
  // Try to import the compiled logger
  const loggerModule = await import("./dist/util/logger.js");
  logger = loggerModule.logger;
} catch {
  // Fallback to console if logger not available (e.g., not built yet)
  logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Colors for output
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
};

/**
 * Parse the build.mjs file to extract defined aliases
 */
function getDefinedAliases() {
  const buildPath = resolve(__dirname, "build.mjs");
  const buildContent = readFileSync(buildPath, "utf8");

  // Find the alias object in the build file
  const aliasMatch = buildContent.match(/alias:\s*{([^}]+)}/s);
  if (!aliasMatch) {
    logger.warn(
      `${colors.yellow}Warning: No aliases found in build.mjs${colors.reset}`,
    );
    return new Set();
  }

  // Extract package names from the alias definitions
  // Split by lines and filter out comments
  const aliasBlock = aliasMatch[1];
  const lines = aliasBlock.split("\n");
  const aliases = new Set();

  for (const line of lines) {
    // Skip commented lines
    if (line.trim().startsWith("//")) {
      continue;
    }

    // Look for package names in non-commented lines
    // Match both quoted and unquoted keys
    const quotedMatch = line.match(/"([^"]+)":/);
    const unquotedMatch = line.match(/\s+([a-zA-Z@][a-zA-Z0-9@\/_-]*)\s*:/);

    if (quotedMatch) {
      aliases.add(quotedMatch[1]);
    } else if (
      unquotedMatch &&
      !unquotedMatch[1].includes("__dirname") &&
      unquotedMatch[1] !== "js"
    ) {
      aliases.add(unquotedMatch[1]);
    }
  }

  return aliases;
}

/**
 * Find all local packages referenced with file: in package.json files
 */
export function findLocalPackages(startPath, visited = new Set()) {
  // Package name -> its folder
  const localPackages = new Map();

  function scanPackageJson(packageJsonPath, depth = 0) {
    // Avoid infinite recursion
    if (visited.has(packageJsonPath) || depth > 10) {
      return;
    }
    visited.add(packageJsonPath);

    if (!existsSync(packageJsonPath)) {
      return;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const packageDir = dirname(packageJsonPath);

      // Check both dependencies and devDependencies
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      for (const [depName, depVersion] of Object.entries(allDeps)) {
        if (typeof depVersion === "string" && depVersion.startsWith("file:")) {
          // This is a local package
          const depPath = resolve(packageDir, depVersion.replace("file:", ""));
          localPackages.set(depName, depPath);

          // Recursively check this package's dependencies
          const depPackageJson = resolve(depPath, "package.json");

          if (existsSync(depPackageJson)) {
            scanPackageJson(depPackageJson, depth + 1);
          }
        }
      }
    } catch (error) {
      logger.error(
        `${colors.red}Error reading ${packageJsonPath}: ${error.message}${colors.reset}`,
      );
    }
  }

  // Start from the CLI's package.json
  scanPackageJson(startPath);

  return localPackages;
}

/**
 * The alias each subpath a local package exports needs, and the file it must
 * point at. esbuild aliases match by prefix, so the package's own alias would
 * send "<package>/<subpath>" to "<package>/dist/index.js/<subpath>".
 */
function subpathAliases(localPackages) {
  const required = new Map();
  for (const [name, dir] of localPackages) {
    let exportsMap;
    try {
      exportsMap = JSON.parse(
        readFileSync(resolve(dir, "package.json"), "utf8"),
      ).exports;
    } catch {
      continue;
    }
    for (const [subpath, target] of Object.entries(exportsMap ?? {})) {
      const file = typeof target === "string" ? target : target?.default;
      if (subpath.startsWith("./") && typeof file === "string") {
        required.set(`${name}${subpath.slice(1)}`, resolve(dir, file));
      }
    }
  }
  return required;
}

/**
 * Subpath aliases that build.mjs lacks or points at another file. Reads the
 * aliases written as resolve(__dirname, "<path>").
 */
export function wrongSubpathAliases(buildContent, localPackages) {
  const targets = new Map(
    [
      ...buildContent.matchAll(
        /"([^"]+)":\s*resolve\(\s*__dirname,\s*"([^"]+)",?\s*\)/g,
      ),
    ].map(([, alias, path]) => [alias, resolve(__dirname, path)]),
  );
  return [...subpathAliases(localPackages)]
    .filter(([alias, file]) => targets.get(alias) !== file)
    .map(([alias, file]) => ({ alias, file }));
}

/**
 * Main validation function
 */
function validateAliases() {
  logger.info(
    `${colors.blue}🔍 Validating esbuild aliases...${colors.reset}\n`,
  );

  // Get defined aliases from build.mjs
  const definedAliases = getDefinedAliases();
  // console.log(`Found ${definedAliases.size} aliases in build.mjs:`);
  // definedAliases.forEach(alias => {
  //   console.log(`  ✓ ${alias}`);
  // });
  // console.log();

  // Find all local packages that need aliases
  const cliPackageJson = resolve(__dirname, "package.json");
  const localPackages = findLocalPackages(cliPackageJson);
  // console.log(`Found ${localPackages.size} local package dependencies:`);
  // localPackages.forEach(pkg => {
  //   console.log(`  • ${pkg}`);
  // });
  // console.log();

  // Check for missing aliases
  const missingAliases = [];
  for (const pkg of localPackages.keys()) {
    if (!definedAliases.has(pkg)) {
      missingAliases.push(pkg);
    }
  }

  // Check for unnecessary aliases (defined but not used)
  const unnecessaryAliases = [];
  // A subpath a local package exports ("@scope/pkg/sub") needs one as well
  const exportedSubpaths = subpathAliases(localPackages);
  for (const alias of definedAliases) {
    if (!localPackages.has(alias) && !exportedSubpaths.has(alias)) {
      unnecessaryAliases.push(alias);
    }
  }

  // Report results
  if (missingAliases.length > 0) {
    logger.error(
      `${colors.red}❌ Missing aliases (WILL CAUSE RUNTIME ERRORS):${colors.reset}`,
    );
    missingAliases.forEach((pkg) => {
      logger.error(`  ✗ ${pkg}`);
    });
    logger.error("");
    logger.error(
      `${colors.red}Add these to the alias section in build.mjs:${colors.reset}`,
    );
    missingAliases.forEach((pkg) => {
      const packageName = pkg.replace("@continuedev/", "").replace(/-/g, "_");
      logger.error(
        `  "${pkg}": resolve(__dirname, "../../packages/${pkg.replace("@continuedev/", "")}/dist/index.js"),`,
      );
    });
    logger.error("");
  }

  if (unnecessaryAliases.length > 0) {
    logger.warn(
      `${colors.yellow}⚠️  Potentially unnecessary aliases:${colors.reset}`,
    );
    unnecessaryAliases.forEach((alias) => {
      logger.warn(`  ? ${alias}`);
    });
    logger.warn("");
  }

  const wrongSubpaths = wrongSubpathAliases(
    readFileSync(resolve(__dirname, "build.mjs"), "utf8"),
    localPackages,
  );
  if (wrongSubpaths.length > 0) {
    logger.error(
      `${colors.red}❌ Subpath aliases missing or pointing at another file:${colors.reset}`,
    );
    wrongSubpaths.forEach(({ alias, file }) => {
      logger.error(`  ✗ ${alias} must point at ${file}`);
    });
    logger.error("");
  }

  // Exit with appropriate code
  if (wrongSubpaths.length > 0) {
    logger.error(
      `${colors.red}✗ Validation failed! ${wrongSubpaths.length} subpath alias(es) wrong.${colors.reset}`,
    );
    process.exit(1);
  } else if (missingAliases.length > 0) {
    logger.error(
      `${colors.red}✗ Validation failed! Missing ${missingAliases.length} required alias(es).${colors.reset}`,
    );
    logger.error(
      `${colors.red}This would cause runtime errors in the bundled CLI.${colors.reset}`,
    );
    process.exit(1);
  } else if (unnecessaryAliases.length > 0) {
    logger.warn(
      `${colors.yellow}✓ Validation passed with warnings.${colors.reset}`,
    );
    process.exit(0);
  } else {
    logger.info(
      `${colors.green}✅ All aliases are correctly configured!${colors.reset}`,
    );
    process.exit(0);
  }
}

// Run validation when run as a script (the build), not when a test imports it
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  validateAliases();
}
