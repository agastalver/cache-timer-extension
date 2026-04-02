import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

let cachedWindowsHome: string | undefined | null;
let cachedWindowsAppData: string | undefined | null;

export function isWSL(): boolean {
  return vscode.env.remoteName === "wsl";
}

function resolveWindowsEnvVar(varName: string): string | undefined {
  try {
    const winPath = execSync(`cmd.exe /C "echo %${varName}%"`, {
      encoding: "utf-8",
      timeout: 10_000,
    })
      .replace(/\r?\n/g, "")
      .trim();

    if (!winPath || winPath === `%${varName}%`) {
      return undefined;
    }

    return execSync(`wslpath -u "${winPath}"`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function getWindowsHome(log?: vscode.OutputChannel): string | undefined {
  if (cachedWindowsHome !== undefined) {
    return cachedWindowsHome ?? undefined;
  }
  const result = resolveWindowsEnvVar("USERPROFILE");
  cachedWindowsHome = result ?? null;
  if (result) {
    log?.appendLine(`[HostPaths] Resolved Windows USERPROFILE: ${result}`);
  } else {
    log?.appendLine("[HostPaths] Failed to resolve Windows USERPROFILE");
  }
  return result;
}

function getWindowsAppData(log?: vscode.OutputChannel): string | undefined {
  if (cachedWindowsAppData !== undefined) {
    return cachedWindowsAppData ?? undefined;
  }
  const result = resolveWindowsEnvVar("APPDATA");
  cachedWindowsAppData = result ?? null;
  if (result) {
    log?.appendLine(`[HostPaths] Resolved Windows APPDATA: ${result}`);
  } else {
    log?.appendLine("[HostPaths] Failed to resolve Windows APPDATA");
  }
  return result;
}

/**
 * Returns the path to the `.cursor` directory. On WSL, this resolves to the
 * Windows host's `%USERPROFILE%/.cursor` via the `/mnt/` mount, since Cursor
 * stores its data on the Windows side even when the workspace is in WSL.
 */
export function getCursorHome(log?: vscode.OutputChannel): string {
  if (isWSL()) {
    const winHome = getWindowsHome(log);
    if (winHome) {
      return path.join(winHome, ".cursor");
    }
    log?.appendLine(
      "[HostPaths] WSL detected but could not resolve Windows home, falling back to local"
    );
  }
  return path.join(os.homedir(), ".cursor");
}

/**
 * Returns the path to the Cursor config directory (containing
 * `User/workspaceStorage/`). On Linux/Mac this is `~/.config/Cursor`; on
 * Windows it is `%APPDATA%/Cursor`. When running inside WSL the Windows
 * AppData path is resolved through the `/mnt/` mount.
 */
export function getCursorConfigHome(log?: vscode.OutputChannel): string {
  if (isWSL()) {
    const winAppData = getWindowsAppData(log);
    if (winAppData) {
      return path.join(winAppData, "Cursor");
    }
    log?.appendLine(
      "[HostPaths] WSL detected but could not resolve Windows AppData, falling back to local"
    );
  }
  return path.join(os.homedir(), ".config", "Cursor");
}
