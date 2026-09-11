// The main process imports @jolo/launcher, a package shared with the Bun-hosted CLI. That package
// tells the two runtimes apart with `typeof Bun !== "undefined"`, so the identifier has to resolve
// here even though Electron's Node never defines it. Declared with no shape on purpose: nothing in
// the main process may call a Bun API, only observe that there is none.
//
// This declaration is deliberately scoped to this program rather than to the launcher package,
// because a package-level one would collide with the real `Bun` global that @types/bun contributes
// to every Bun-typed program.
declare const Bun: undefined;
