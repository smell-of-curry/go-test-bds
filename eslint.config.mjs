import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import minecraftLinting from "eslint-plugin-minecraft-linting";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: [
      // Generated Files
      "**/__generated__/**",
      "node_modules/**",
    ],
  },
  {
    files: [".husky/scripts/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        project: ["./tsconfig.json"],
      },
    },
    plugins: {
      import: importPlugin,
      "@typescript-eslint": tsPlugin,
      "minecraft-linting": minecraftLinting,
    },
    rules: {
      "minecraft-linting/avoid-unnecessary-command": "error",

      // Enforce type-only imports (auto-fixable):
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],

      // Prevent leftover side-effect imports when using type imports
      "@typescript-eslint/no-import-type-side-effects": "error",

      // Import sorting (auto-fixable):
      "import/order": [
        "error",
        {
          groups: [
            "builtin", // e.g. fs, path
            "external", // e.g. modules from node_modules
            "internal", // e.g. your app’s aliases
            "parent", // ../*
            "sibling", // ./*
            "index", // . (i.e. import from './')
          ],
        },
      ],

      // Prevent import cycles (limited depth to reduce memory usage)
      "import/no-cycle": ["error", { maxDepth: 5 }],
    },
  },
];
