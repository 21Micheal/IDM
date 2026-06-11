module.exports = [
  // Ignore build and dependency folders
  {
    ignores: ["node_modules/**", "dist/**", "dist_new/**", "dist_verify/**"],
  },

  // Apply to JS/TS and React files
  {
    files: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": require("@typescript-eslint/eslint-plugin"),
      "react-hooks": require("eslint-plugin-react-hooks"),
    },
    rules: {
      // TypeScript-specific
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      // Relax some react rules (project may use new JSX transform)
      // Note: `eslint-plugin-react` isn't installed in the frontend container,
      // so react-specific rules are omitted here.

      // Basic stylistic choices - allow project defaults; enable some useful checks
      "no-console": ["warn", { "allow": ["warn", "error"] }],
      "no-debugger": "warn",
    },
  },
];
