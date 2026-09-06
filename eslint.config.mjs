import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent-generated workspace and runtime data
    "data/**",
    "artifacts/**",
    ".workbench/**",
    // Git worktrees (created by parallel agent workflows). Two locations,
    // because the harness puts them under .claude/worktrees/ while the
    // documented convention is .worktrees/ — a checkout of another branch is
    // not this checkout's source either way, and linting one reports every
    // finding twice.
    ".worktrees/**",
    ".claude/**",
    // Electron build output (compiled from electron/*.ts)
    "electron-dist/**",
    "release/**",
    // Extension page bundles (written by each extension's scripts/build.mjs)
    "extensions/*/dist/**",
  ]),
  // Omitting a key by destructuring it away is not an unused variable.
  //
  // `const { onRefresh, ...rest } = props` is how you drop a key, and the
  // binding exists precisely so that it does not end up in `rest`. eslint's own
  // default for `ignoreRestSiblings` is true; the Next preset turns it off, so
  // every use of the idiom in this repo was reported. Restoring the default
  // removes a class of false positives without hiding a real one: a rest
  // sibling is never a variable somebody forgot to use.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  // An extension's page bundle is plain React, not Next: it is built by
  // esbuild and served as a static asset, so `next/image` does not exist there
  // and the rule has nothing to suggest that would work.
  {
    files: ["extensions/*/ui/**"],
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  // Prevent console.* in server-side code — use `import { log } from '@/lib/server/logger'` instead.
  {
    files: ["src/lib/server/**/*.ts", "src/lib/providers/**/*.ts", "src/app/api/**/*.ts", "src/instrumentation.ts"],
    ignores: ["**/*.test.ts", "src/lib/server/logger.ts"],
    rules: {
      "no-console": "warn",
    },
  },
]);

export default eslintConfig;
