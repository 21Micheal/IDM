module.exports = [
  // Ignore build and dependency folders
  {
    ignores: ["node_modules/**", "dist/**", "frontend/dist/**", "frontend/dist_new/**", "frontend/dist_verify/**"],
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
      react: require("eslint-plugin-react"),
      "react-hooks": require("eslint-plugin-react-hooks"),
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // TypeScript-specific
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      // Relax some react rules (project may use new JSX transform)
      "react/react-in-jsx-scope": "off",

      // Basic stylistic choices - allow project defaults; enable some useful checks
      "no-console": ["warn", { "allow": ["warn", "error"] }],
      "no-debugger": "warn",
    },
  },
];
