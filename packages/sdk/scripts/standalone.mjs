import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [new URL("../src/standalone.ts", import.meta.url).pathname],
  outfile: new URL("../dist/misty-sdk.js", import.meta.url).pathname,
  bundle: true,
  format: "iife",
  globalName: "MistySDK",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "eof",
  banner: {
    js: `/*! @misty/sdk ${version}, MIT. Bundles yjs, y-protocols and lib0, MIT, Copyright (c) Kevin Jahns. */`,
  },
});
