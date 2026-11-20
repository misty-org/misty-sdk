import js from "@eslint/js";
import tseslint from "typescript-eslint";

// The SDK is MIT and the host is AGPL: nothing here may import host code.
const hostImports = [
  { group: ["@misty/app", "@misty/app/*"], message: "The SDK never imports host (AGPL) code." },
  { group: ["@tauri-apps/*"], message: "The SDK talks to Misty only through its channel." },
  { group: ["**/src-tauri/**", "**/misty/src/**"], message: "The SDK never imports host (AGPL) code." },
];

export default tseslint.config(
  { ignores: ["**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "no-restricted-imports": ["error", { patterns: hostImports }] } },
);
