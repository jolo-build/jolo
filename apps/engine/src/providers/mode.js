// Release bundles replace NODE_ENV at build time, so runtime environment variables
// cannot turn the demo back on. Source runs also honor an explicit production mode.
const developmentBuild = process.env.NODE_ENV !== "production";

export function demoProviderEnabled(env = process.env) {
  return developmentBuild && env.NODE_ENV !== "production";
}
