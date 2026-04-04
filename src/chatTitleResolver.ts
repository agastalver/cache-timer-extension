import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execFile } from "child_process";
import { getCursorConfigHome } from "./hostPaths";

interface ComposerHead {
  composerId: string;
  name: string | null;
  createdAt?: number;
  lastUpdatedAt?: number | null;
  workspaceIdentifier?: {
    id?: string;
    uri?: { fsPath?: string };
  };
}

/**
 * Reads chat titles from Cursor's SQLite state databases.
 *
 * Newer Cursor versions store composer headers globally:
 *   ~/.config/Cursor/User/globalStorage/state.vscdb
 * under "composer.composerHeaders" (allComposers filtered by workspace).
 *
 * Older / fallback: workspace-specific DB:
 *   ~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb
 * under "composer.composerData".
 */
export class ChatTitleResolver implements vscode.Disposable {
  private titleCache = new Map<string, string>();
  private dbPath: string | undefined;
  private globalDbPath: string | undefined;
  /** Workspace storage folder name (matches workspaceIdentifier.id in global DB). */
  private workspaceStorageFolderId: string | undefined;
  private workspaceFolderFsPath: string | undefined;
  private refreshInterval: ReturnType<typeof setInterval> | undefined;

  private readonly _onDidRefresh = new vscode.EventEmitter<
    Map<string, string>
  >();
  readonly onDidRefresh = this._onDidRefresh.event;

  constructor(private readonly log: vscode.OutputChannel) {
    const folders = vscode.workspace.workspaceFolders;
    this.workspaceFolderFsPath = folders?.[0]?.uri.fsPath;

    this.dbPath = this.findWorkspaceStateDb();
    if (this.dbPath) {
      this.log.appendLine(`[ChatTitleResolver] Workspace DB path: ${this.dbPath}`);
    } else {
      this.log.appendLine(
        "[ChatTitleResolver] Could not find workspace state.vscdb"
      );
    }

    const globalCandidate = path.join(
      getCursorConfigHome(this.log),
      "User",
      "globalStorage",
      "state.vscdb"
    );
    if (fs.existsSync(globalCandidate)) {
      this.globalDbPath = globalCandidate;
      this.log.appendLine(`[ChatTitleResolver] Global DB path: ${this.globalDbPath}`);
    } else {
      this.log.appendLine(
        `[ChatTitleResolver] Global state.vscdb not found: ${globalCandidate}`
      );
    }

    this.refreshSync();
    this.refreshInterval = setInterval(() => this.refreshAsync(), 5_000);
  }

  getTitle(chatId: string): string | undefined {
    return this.titleCache.get(chatId);
  }

  getAllTitles(): Map<string, string> {
    return this.titleCache;
  }

  private findWorkspaceStateDb(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.log.appendLine("[ChatTitleResolver] No workspace folders open");
      return undefined;
    }

    const workspaceUri = folders[0].uri.toString();
    this.log.appendLine(
      `[ChatTitleResolver] Looking for workspace URI: ${workspaceUri}`
    );

    const storageRoot = path.join(
      getCursorConfigHome(this.log),
      "User",
      "workspaceStorage"
    );

    if (!fs.existsSync(storageRoot)) {
      this.log.appendLine(
        `[ChatTitleResolver] Storage root does not exist: ${storageRoot}`
      );
      return undefined;
    }

    try {
      for (const entry of fs.readdirSync(storageRoot, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const wsJsonPath = path.join(storageRoot, entry.name, "workspace.json");
        if (!fs.existsSync(wsJsonPath)) {
          continue;
        }
        try {
          const wsData = JSON.parse(fs.readFileSync(wsJsonPath, "utf-8"));
          if (wsData.folder === workspaceUri) {
            const candidate = path.join(storageRoot, entry.name, "state.vscdb");
            if (fs.existsSync(candidate)) {
              this.workspaceStorageFolderId = entry.name;
              return candidate;
            }
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      this.log.appendLine(
        `[ChatTitleResolver] Error scanning storage root: ${err}`
      );
    }

    return undefined;
  }

  /** Whether a global composer row belongs to the current workspace. */
  private matchesCurrentWorkspace(c: ComposerHead): boolean {
    const wi = c.workspaceIdentifier;
    if (!wi) {
      return false;
    }
    if (
      this.workspaceStorageFolderId &&
      wi.id === this.workspaceStorageFolderId
    ) {
      return true;
    }
    const remoteFs = wi.uri?.fsPath;
    if (remoteFs && this.workspaceFolderFsPath) {
      return this.pathsEqual(remoteFs, this.workspaceFolderFsPath);
    }
    return false;
  }

  private pathsEqual(a: string, b: string): boolean {
    const na = path.normalize(a);
    const nb = path.normalize(b);
    if (na === nb) {
      return true;
    }
    if (process.platform === "win32") {
      return na.toLowerCase() === nb.toLowerCase();
    }
    return false;
  }

  /**
   * Parses global `composer.composerHeaders` JSON (all workspaces); only entries
   * for the current workspace are cached.
   */
  private parseComposerHeaders(raw: string): void {
    try {
      const data = JSON.parse(raw.trim());
      const composers: ComposerHead[] = data.allComposers ?? [];
      for (const c of composers) {
        if (!c.composerId || !c.name) {
          continue;
        }
        if (!this.matchesCurrentWorkspace(c)) {
          continue;
        }
        this.titleCache.set(c.composerId, c.name);
      }
    } catch {
      // Malformed JSON
    }
  }

  private parseComposerData(raw: string): void {
    try {
      const data = JSON.parse(raw.trim());
      const composers: ComposerHead[] = data.allComposers ?? [];
      for (const c of composers) {
        if (c.composerId && c.name) {
          this.titleCache.set(c.composerId, c.name);
        }
      }
    } catch {
      // Malformed JSON
    }
  }

  private querySqlite(dbPath: string, sql: string): string {
    return execFileSync(
      "sqlite3",
      [`file://${dbPath}?immutable=1`, sql],
      {
        timeout: 5000,
        encoding: "utf-8",
      }
    );
  }

  private refreshSync(): void {
    this.titleCache.clear();

    if (this.globalDbPath) {
      const q =
        "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'";
      try {
        const stdout = this.querySqlite(this.globalDbPath, q);
        if (stdout.trim()) {
          this.parseComposerHeaders(stdout);
        }
      } catch (err) {
        this.log.appendLine(
          `[ChatTitleResolver] Global sqlite3 query failed: ${err}`
        );
      }
    }

    if (this.dbPath) {
      const q =
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData'";
      try {
        const stdout = this.querySqlite(this.dbPath, q);
        if (stdout.trim()) {
          this.parseComposerData(stdout);
        }
      } catch (err) {
        this.log.appendLine(
          `[ChatTitleResolver] Workspace sqlite3 query failed (is sqlite3 installed?): ${err}`
        );
      }
    }

    this.log.appendLine(
      `[ChatTitleResolver] Loaded ${this.titleCache.size} title(s) total`
    );
  }

  private refreshAsync(): void {
    this.titleCache.clear();

    const loadWorkspaceAndEmit = (): void => {
      if (!this.dbPath) {
        this._onDidRefresh.fire(this.titleCache);
        return;
      }
      const q =
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData'";
      execFile(
        "sqlite3",
        [`file://${this.dbPath}?immutable=1`, q],
        { timeout: 5000 },
        (err, stdout) => {
          if (!err && stdout?.trim()) {
            this.parseComposerData(stdout);
          }
          this._onDidRefresh.fire(this.titleCache);
        }
      );
    };

    if (!this.globalDbPath) {
      loadWorkspaceAndEmit();
      return;
    }

    const globalQ =
      "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'";
    execFile(
      "sqlite3",
      [`file://${this.globalDbPath}?immutable=1`, globalQ],
      { timeout: 5000 },
      (err, stdout) => {
        if (!err && stdout?.trim()) {
          this.parseComposerHeaders(stdout);
        }
        loadWorkspaceAndEmit();
      }
    );
  }

  dispose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this._onDidRefresh.dispose();
  }
}
