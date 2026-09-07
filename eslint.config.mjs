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
  // The two patterns the codemods removed, kept out.
  //
  // scripts/codemod-surfaces.mjs rewrote 1323 white-alpha utilities and
  // scripts/codemod-radius.mjs rewrote 1837 arbitrary radii. Neither script
  // runs again, so without this a single new component starts the drift over,
  // and nothing else would notice: a Tailwind class whose theme key does not
  // exist is dropped silently -- no build error, no lint error, no type error.
  //
  // Both selectors read template chunks as well as string literals, because a
  // className is as often built as it is written.
  //
  // Scope notes, each one load-bearing:
  //  - The white-alpha selector covers the shorthand `white/10` as well as the
  //    bracket `white/[0.10]`. The surfaces codemod only ever matched the
  //    bracket form, so the shorthand spelling is both the untouched one and
  //    the easier one to type; a guard on the bracket form alone would leave
  //    the wider door open. That is why this rule reports on sites the codemod
  //    never rewrote -- see .eslint-baseline.json for the ones that stay.
  //  - The radius selector requires a numeric length, so `rounded-[inherit]`
  //    (src/components/ui/scroll-area.tsx: a primitive taking its parent's
  //    corner) is left alone. A rule that forces a disable comment is worse
  //    than a narrower rule.
  //  - Opaque `bg-white` / `text-white` are not flagged: there is no alpha
  //    channel being hardcoded, and the always-dark share page needs them.
  {
    files: ["src/**/*.tsx", "src/**/*.ts"],
    // Every fixture in the guard's own test is by construction one of the
    // patterns below.
    ignores: ["src/lib/app/lint-guard-fixtures.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "Literal[value=/(?:bg|border|divide|ring|outline|text)(?:-[xytblrse])?-white\\/(?:\\[|\\d)/]",
          message:
            "Use the surface ladder (bg-layer-1..4, border-line-*, text-fg-1..3), not a hardcoded white alpha. This covers both white/[0.06] and the shorthand white/6.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:bg|border|divide|ring|outline|text)(?:-[xytblrse])?-white\\/(?:\\[|\\d)/]",
          message:
            "Use the surface ladder (bg-layer-1..4, border-line-*, text-fg-1..3), not a hardcoded white alpha. This covers both white/[0.06] and the shorthand white/6.",
        },
        {
          selector:
            "Literal[value=/rounded(?:-(?:tl|tr|bl|br|ss|se|es|ee|t|b|l|r|s|e))?-\\[\\d*\\.?\\d+(?:px|rem|em)\\]/]",
          message:
            "Use the radius scale (rounded-xs|sm|md|lg|full), not an arbitrary pixel radius.",
        },
        {
          selector:
            "TemplateElement[value.raw=/rounded(?:-(?:tl|tr|bl|br|ss|se|es|ee|t|b|l|r|s|e))?-\\[\\d*\\.?\\d+(?:px|rem|em)\\]/]",
          message:
            "Use the radius scale (rounded-xs|sm|md|lg|full), not an arbitrary pixel radius.",
        },
      ],
    },
  },
]);

export default eslintConfig;
