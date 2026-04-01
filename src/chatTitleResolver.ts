import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, execFile } from "child_process";

interface ComposerHead {
  composerId: string;
  name: string | null;
  createdAt: number;
  lastUpdatedAt: number | null;
}

/**
 * Reads chat titles from the workspace-specific state.vscdb SQLite database.
 * Cursor stores chat metadata in:
 *   ~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb
 * under the key "composer.composerData", which contains an "allComposers" array
 * with each chat's composerId (= transcript UUID) and name (title).
 */
export class ChatTitleResolver implements vscode.Disposable {
  private titleCache = new Map<string, string>();
  private dbPath: string | undefined;
  private refreshInterval: ReturnType<typeof setInterval> | undefined;

  private readonly _onDidRefresh = new vscode.EventEmitter<
    Map<string, string>
  >();
  readonly onDidRefresh = this._onDidRefresh.event;

  constructor(private readonly log: vscode.OutputChannel) {
    this.dbPath = this.findWorkspaceStateDb();
    if (this.dbPath) {
      this.log.appendLine(`[ChatTitleResolver] DB path: ${this.dbPath}`);
    } else {
      this.log.appendLine("[ChatTitleResolver] Could not find workspace state.vscdb");
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
    this.log.appendLine(`[ChatTitleResolver] Looking for workspace URI: ${workspaceUri}`);

    const storageRoot = path.join(
      os.homedir(),
      ".config",
      "Cursor",
      "User",
      "workspaceStorage"
    );

    if (!fs.existsSync(storageRoot)) {
      this.log.appendLine(`[ChatTitleResolver] Storage root does not exist: ${storageRoot}`);
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
            const dbPath = path.join(storageRoot, entry.name, "state.vscdb");
            if (fs.existsSync(dbPath)) {
              return dbPath;
            }
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      this.log.appendLine(`[ChatTitleResolver] Error scanning storage root: ${err}`);
    }

    return undefined;
  }

  private parseComposerData(raw: string, emit = false): void {
    try {
      const data = JSON.parse(raw.trim());
      const composers: ComposerHead[] = data.allComposers ?? [];
      for (const c of composers) {
        if (c.composerId && c.name) {
          this.titleCache.set(c.composerId, c.name);
        }
      }
      if (emit) {
        this._onDidRefresh.fire(this.titleCache);
      }
    } catch {
      // Malformed JSON
    }
  }

  private refreshSync(): void {
    if (!this.dbPath) {
      return;
    }
    const query =
      "SELECT value FROM ItemTable WHERE key = 'composer.composerData'";
    try {
      const stdout = execFileSync("sqlite3", [`file://${this.dbPath}?immutable=1`, query], {
        timeout: 5000,
        encoding: "utf-8",
      });
      this.parseComposerData(stdout);
      this.log.appendLine(`[ChatTitleResolver] Loaded ${this.titleCache.size} title(s) from DB`);
    } catch (err) {
      this.log.appendLine(`[ChatTitleResolver] sqlite3 query failed (is sqlite3 installed?): ${err}`);
    }
  }

  private refreshAsync(): void {
    if (!this.dbPath) {
      return;
    }
    const query =
      "SELECT value FROM ItemTable WHERE key = 'composer.composerData'";
    execFile(
      "sqlite3",
      [`file://${this.dbPath}?immutable=1`, query],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          return;
        }
        this.parseComposerData(stdout, true);
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
