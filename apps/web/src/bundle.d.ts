/**
 * The generated browser bundle, imported as text.
 *
 * `build.mjs` writes `client.bundle.js.txt` and esbuild's text loader turns it
 * into a string at Worker build time. The file is generated, so it is declared
 * here rather than committed.
 */
declare module '*.js.txt' {
  const contents: string;
  export default contents;
}
