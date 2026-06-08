import { defineConfig, globalIgnores } from "eslint/config";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([
    // Exclude build outputs, the cached VS Code download used by the
    // integration test runner, and the integration test workspace fixture
    // so ESLint does not pick up third-party eslint.config.mjs files
    // from inside the test environment.
    globalIgnores([
        "**/dist",
        "**/out",
        "**/node_modules",
        "**/scripts",
        "**/coverage",
        "**/.vscode-test",
    ]),

    // Phase 1: Root-level & test files are NOT included in any package tsconfig.
    // Disable type-aware linting (parserOptions.project) to avoid
    // "Parsing error: none of those TSConfigs include this file".
    {
        files: [
            "eslint.config.mjs",
            "vitest.config.ts",
            "tests/**/*",
        ],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
        },
        plugins: {
            "@typescript-eslint": typescriptEslint,
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": "warn",
            semi: ["error", "always"],
        },
    },

    // Package source files: full type-aware linting with strict rule set.
    {
        files: [
            "src/**/*.ts",
        ],
        extends: compat.extends(
            "eslint:recommended",
            "plugin:@typescript-eslint/recommended",
            "plugin:@typescript-eslint/recommended-requiring-type-checking",
        ),

        plugins: {
            "@typescript-eslint": typescriptEslint,
        },

        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",

            parserOptions: {
                project: ["./tsconfig.json"],
            },
        },

        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/consistent-type-imports": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
        },
    },
]);
