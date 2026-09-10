// Workspace-relative path resolution. Rejects escapes, symlinks, and repository metadata.
import { lstatSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
  }
}

const MAX_PATH_BYTES = 4096;

/**
 * @param {string} root absolute, already-canonical workspace root
 * @param {string} relativePath model- or user-supplied relative path
 * @param {{ mustExist?: boolean }} [options]
 */
export function resolveWorkspacePath(root, relativePath, options = {}) {
  const mustExist = options.mustExist ?? true;
  if (typeof relativePath !== "string") throw new WorkspacePathError("invalid_path", "path must be a string");
  if (Buffer.byteLength(relativePath) > MAX_PATH_BYTES) throw new WorkspacePathError("invalid_path", "path is too long");
  if (relativePath.includes("\0")) throw new WorkspacePathError("invalid_path", "path contains a NUL byte");
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("\\")) {
    throw new WorkspacePathError("invalid_path", "absolute paths are not allowed; use a workspace-relative path");
  }
  const components = relativePath.split(/[\\/]+/).filter((c) => c !== "" && c !== ".");
  if (components.some((c) => c === "..")) throw new WorkspacePathError("invalid_path", "path escapes the workspace");
  if (components.some((c) => c === ".git")) throw new WorkspacePathError("repository_metadata", "repository control metadata is not accessible through file tools");
  let current = root;
  let stat = null;
  for (let i = 0; i < components.length; i += 1) {
    const candidate = path.join(current, components[i]);
    let entry;
    try {
      entry = lstatSync(candidate);
    } catch {
      if (mustExist) throw new WorkspacePathError("not_found", `no such path: ${components.slice(0, i + 1).join("/")}`);
      // Remaining components do not exist yet; they will be created inside the validated prefix.
      return { absolute: path.join(current, ...components.slice(i)), relative: components.join("/"), stat: null };
    }
    if (entry.isSymbolicLink()) throw new WorkspacePathError("symlink_denied", `symlinks are not followed in v1: ${components.slice(0, i + 1).join("/")}`);
    if (i < components.length - 1 && !entry.isDirectory()) throw new WorkspacePathError("not_found", `not a directory: ${components.slice(0, i + 1).join("/")}`);
    if (i === components.length - 1 && !entry.isDirectory() && !entry.isFile()) throw new WorkspacePathError("special_file", "only regular files and directories are accessible");
    current = candidate;
    stat = entry;
  }
  if (stat === null) stat = lstatSync(root);
  return { absolute: current, relative: components.join("/"), stat };
}
