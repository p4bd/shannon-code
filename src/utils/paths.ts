import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export function resolveInsideCwd(cwd: string, requestedPath: string): string {
  const root = resolve(cwd);
  const resolved = resolve(root, requestedPath);

  if (isPathInside(root, resolved)) {
    return resolved;
  }

  throw new PathOutsideWorkspaceError(requestedPath);
}

export async function assertRealPathInsideCwd(
  cwd: string,
  absolutePath: string,
): Promise<void> {
  const root = resolve(cwd);
  const realRoot = await realpath(root);
  const realTarget = await realpathNearestExisting(absolutePath);

  if (!isPathInside(realRoot, realTarget)) {
    throw new PathOutsideWorkspaceError(toWorkspacePath(cwd, absolutePath));
  }
}

export function toWorkspacePath(cwd: string, absolutePath: string): string {
  const relativePath = relative(resolve(cwd), resolve(absolutePath));
  return relativePath === "" ? "." : relativePath.replaceAll("\\", "/");
}

export class PathOutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`Path is outside the current workspace: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\") || path.startsWith("/");
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsoluteLike(relativePath))
  );
}

async function realpathNearestExisting(path: string): Promise<string> {
  let current = resolve(path);

  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }

      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
