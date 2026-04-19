import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { getCursorConfigHome } from "./hostPaths";

/**
 * Default `maxBuffer` for `execFile` is 1 MiB, which the Cursor global state
 * JSON can exceed easily (it holds metadata for every chat in every
 * workspace). We cap stdout at 32 MiB just in case — on a normal install the
 * filtered result is only a few KB.
 */
const SQLITE_MAX_BUFFER = 32 * 1024 * 1024;
const SQLITE_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 30_000;

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
 *
 * The queries filter using SQLite's JSON functions so only rows belonging to
 * the current workspace cross the process boundary, which keeps memory flat
 * even when the global DB is several GB.
 */
export class ChatTitleResolver implements vscode.Disposable {
  private titleCache = new Map<string, string>();
  private dbPath: string | undefined;
  private globalDbPath: string | undefined;
  /** Workspace storage folder name (matches workspaceIdentifier.id in global DB). */
  private workspaceStorageFolderId: string | undefined;
  private workspaceFolderFsPath: string | undefined;
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

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

    void this.refresh();
    this.refreshInterval = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  getTitle(chatId: string): string | undefined {
    return this.titleCache.get(chatId);
  }

  getAllTitles(): Map<string, string> {
    return this.titleCache;
  }

  /** Request an out-of-schedule refresh (e.g. when a new chat appears). */
  forceRefresh(): void {
    void this.refresh();
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

  private execSqlite(
    dbPath: string,
    sql: string
  ): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        "sqlite3",
        ["-separator", "\t", `file://${dbPath}?immutable=1`, sql],
        {
          timeout: SQLITE_TIMEOUT_MS,
          maxBuffer: SQLITE_MAX_BUFFER,
          encoding: "utf-8",
        },
        (err, stdout) => {
          if (err) {
            this.log.appendLine(
              `[ChatTitleResolver] sqlite3 query failed: ${err}`
            );
            resolve("");
            return;
          }
          resolve(typeof stdout === "string" ? stdout : "");
        }
      );
    });
  }

  /**
   * Query composer headers from the global DB, filtering by the current
   * workspace inside the SQL so the subprocess only emits a few rows instead
   * of the full multi-MB JSON blob.
   */
  private buildGlobalHeadersQuery(): string | undefined {
    const filters: string[] = [];
    if (this.workspaceStorageFolderId) {
      filters.push(
        `json_extract(j.value, '$.workspaceIdentifier.id') = ${sqlString(
          this.workspaceStorageFolderId
        )}`
      );
    }
    if (this.workspaceFolderFsPath) {
      filters.push(
        `json_extract(j.value, '$.workspaceIdentifier.uri.fsPath') = ${sqlString(
          this.workspaceFolderFsPath
        )}`
      );
    }
    if (filters.length === 0) {
      return undefined;
    }

    return [
      "SELECT",
      "  json_extract(j.value, '$.composerId'),",
      "  json_extract(j.value, '$.name')",
      "FROM ItemTable, json_each(json_extract(ItemTable.value, '$.allComposers')) j",
      "WHERE ItemTable.key = 'composer.composerHeaders'",
      `  AND (${filters.join(" OR ")});`,
    ].join(" ");
  }

  private buildWorkspaceHeadersQuery(): string {
    return [
      "SELECT",
      "  json_extract(j.value, '$.composerId'),",
      "  json_extract(j.value, '$.name')",
      "FROM ItemTable, json_each(json_extract(ItemTable.value, '$.allComposers')) j",
      "WHERE ItemTable.key = 'composer.composerData';",
    ].join(" ");
  }

  private parseRows(stdout: string, next: Map<string, string>): void {
    if (!stdout) {
      return;
    }
    for (const line of stdout.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) {
        continue;
      }
      const tab = trimmed.indexOf("\t");
      if (tab < 0) {
        continue;
      }
      const id = trimmed.slice(0, tab);
      const name = trimmed.slice(tab + 1);
      if (!id || !name) {
        continue;
      }
      next.set(id, name);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;

    try {
      const next = new Map<string, string>();

      if (this.globalDbPath) {
        const q = this.buildGlobalHeadersQuery();
        if (q) {
          const stdout = await this.execSqlite(this.globalDbPath, q);
          this.parseRows(stdout, next);
        }
      }

      if (this.dbPath) {
        const stdout = await this.execSqlite(
          this.dbPath,
          this.buildWorkspaceHeadersQuery()
        );
        this.parseRows(stdout, next);
      }

      if (this.mergeIntoCache(next)) {
        this.log.appendLine(
          `[ChatTitleResolver] Titles refreshed (${this.titleCache.size} total)`
        );
        this._onDidRefresh.fire(this.titleCache);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** Diff `next` into `titleCache`; returns true iff anything changed. */
  private mergeIntoCache(next: Map<string, string>): boolean {
    let changed = false;

    for (const [id, name] of next) {
      if (this.titleCache.get(id) !== name) {
        this.titleCache.set(id, name);
        changed = true;
      }
    }

    // Evict titles that are no longer in the DB (chat deleted etc.).
    for (const id of this.titleCache.keys()) {
      if (!next.has(id)) {
        this.titleCache.delete(id);
        changed = true;
      }
    }

    return changed;
  }

  dispose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this._onDidRefresh.dispose();
  }
}

/** Escape a value for inclusion as a single-quoted SQL string literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
