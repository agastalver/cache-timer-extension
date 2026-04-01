import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatTitleResolver } from "./chatTitleResolver";

export interface TranscriptEvent {
  chatId: string;
  title: string;
  timestamp: number;
}

export interface UserMessageEvent {
  chatId: string;
  messageText: string;
}

export type WatcherStatus =
  | "no_workspace"
  | "dir_not_found"
  | "watching"
  | "ready";

export class TranscriptWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private throttleTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: boolean }
  >();
  private fallbackTitleCache = new Map<string, string>();
  private streamingSince = new Map<string, number>();
  private lastSeenLineCount = new Map<string, number>();
  private rescanInterval: ReturnType<typeof setInterval> | undefined;

  private readonly _onAssistantMessage =
    new vscode.EventEmitter<TranscriptEvent>();
  readonly onAssistantMessage = this._onAssistantMessage.event;

  private readonly _onChatActivity =
    new vscode.EventEmitter<TranscriptEvent>();
  readonly onChatActivity = this._onChatActivity.event;

  private readonly _onStreamingChange =
    new vscode.EventEmitter<{ chatId: string; streaming: boolean }>();
  readonly onStreamingChange = this._onStreamingChange.event;

  private readonly _onUserMessage =
    new vscode.EventEmitter<UserMessageEvent>();
  readonly onUserMessage = this._onUserMessage.event;

  private _transcriptDir: string | undefined;
  private _status: WatcherStatus = "no_workspace";

  get status(): WatcherStatus {
    return this._status;
  }

  get transcriptDirPath(): string | undefined {
    return this._transcriptDir;
  }

  constructor(
    private readonly titleResolver: ChatTitleResolver,
    private readonly log: vscode.OutputChannel
  ) {}

  isStreaming(chatId: string): boolean {
    return this.streamingSince.has(chatId);
  }

  getStreamingChatIds(): Set<string> {
    return new Set(this.streamingSince.keys());
  }

  async start(): Promise<void> {
    this._transcriptDir = this.resolveTranscriptDir();
    if (!this._transcriptDir) {
      this._status = "no_workspace";
      this.log.appendLine("[TranscriptWatcher] No workspace folder open — cannot resolve transcript directory");
      return;
    }

    this.log.appendLine(`[TranscriptWatcher] Transcript directory: ${this._transcriptDir}`);

    if (!fs.existsSync(this._transcriptDir)) {
      this._status = "dir_not_found";
      this.log.appendLine("[TranscriptWatcher] Directory does not exist");
      return;
    }

    this.log.appendLine("[TranscriptWatcher] Directory exists, scanning...");
    const count = await this.scanExisting();
    this.log.appendLine(`[TranscriptWatcher] Initial scan found ${count} transcript(s)`);
    this._status = count > 0 ? "ready" : "watching";

    this.watchDirectory(this._transcriptDir);

    this.rescanInterval = setInterval(() => this.rescan(), 10_000);
  }

  /**
   * Cursor stores transcripts under ~/.cursor/projects/<slug>/agent-transcripts.
   * On Unix, slug is the workspace path with the leading slash removed and `/`
   * replaced by `-`. Windows paths use backslashes and a drive prefix (`C:\...`);
   * the old `replace(/\//g, "-")` left the full path intact, which produced invalid
   * joined paths like .../projects/c:\Users\...\agent-transcripts.
   */
  private workspacePathToSlug(workspacePath: string): string {
    const normalized = path.normalize(workspacePath).replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.map((segment) => segment.replace(/:$/, "")).join("-");
  }

  private resolveTranscriptDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    const workspacePath = folders[0].uri.fsPath;
    const slug = this.workspacePathToSlug(workspacePath);
    const cursorHome = path.join(os.homedir(), ".cursor");

    this.log.appendLine(`[TranscriptWatcher] Workspace path: ${workspacePath}`);
    this.log.appendLine(`[TranscriptWatcher] Computed slug: ${slug}`);

    return path.join(cursorHome, "projects", slug, "agent-transcripts");
  }

  private async scanExisting(): Promise<number> {
    if (!this._transcriptDir) {
      return 0;
    }

    let count = 0;
    try {
      const entries = fs.readdirSync(this._transcriptDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const jsonlPath = path.join(
          this._transcriptDir,
          entry.name,
          `${entry.name}.jsonl`
        );
        if (fs.existsSync(jsonlPath)) {
          this.processFile(jsonlPath, entry.name, true);
          count++;
        }
      }
    } catch (err) {
      this.log.appendLine(`[TranscriptWatcher] Error scanning directory: ${err}`);
    }
    return count;
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) {
          return;
        }
        if (filename.includes("subagents")) {
          return;
        }

        const parts = filename.split(path.sep);
        if (parts.length < 2) {
          return;
        }
        const chatId = parts[0];
        const fullPath = path.join(dir, filename);

        this.throttle(chatId, () => this.fireActivity(fullPath, chatId));
        this.debounce(chatId, () => this.processFile(fullPath, chatId));
      });

      this.watchers.push(watcher);
      this.log.appendLine("[TranscriptWatcher] fs.watch started (recursive)");
    } catch (err) {
      this.log.appendLine(`[TranscriptWatcher] fs.watch failed: ${err}`);
    }
  }

  forceRescan(): void {
    this.rescan();
  }

  /**
   * Periodic fallback re-scan to catch transcripts that fs.watch may have
   * missed (especially common on Linux where recursive inotify is unreliable).
   */
  private rescan(): void {
    if (!this._transcriptDir || !fs.existsSync(this._transcriptDir)) {
      return;
    }

    const STREAMING_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const [chatId, since] of this.streamingSince) {
      if (now - since > STREAMING_TIMEOUT_MS) {
        this.log.appendLine(`[TranscriptWatcher] Streaming timeout for ${chatId} (${Math.round((now - since) / 1000)}s)`);
        this.clearStreaming(chatId);
      }
    }

    try {
      const entries = fs.readdirSync(this._transcriptDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const jsonlPath = path.join(
          this._transcriptDir,
          entry.name,
          `${entry.name}.jsonl`
        );
        if (!fs.existsSync(jsonlPath)) {
          continue;
        }

        try {
          const stat = fs.statSync(jsonlPath);
          const prevLines = this.lastSeenLineCount.get(entry.name) ?? 0;
          const ageMs = Date.now() - stat.mtimeMs;
          if (prevLines === 0 || ageMs < 15_000) {
            this.processFile(jsonlPath, entry.name);
          }
        } catch {
          // File may be gone
        }
      }
    } catch {
      // Directory may have been removed
    }
  }

  private debounce(key: string, fn: () => void, delayMs = 500): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        fn();
      }, delayMs)
    );
  }

  private throttle(key: string, fn: () => void, intervalMs = 2000): void {
    const existing = this.throttleTimers.get(key);
    if (existing) {
      existing.pending = true;
      return;
    }

    fn();

    const schedule = (): void => {
      const state: { timer: ReturnType<typeof setTimeout>; pending: boolean } =
        {
          timer: setTimeout(() => {
            if (state.pending) {
              state.pending = false;
              fn();
              schedule();
            } else {
              this.throttleTimers.delete(key);
            }
          }, intervalMs),
          pending: false,
        };
      this.throttleTimers.set(key, state);
    };

    schedule();
  }

  private fireActivity(filePath: string, chatId: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (!this.streamingSince.has(chatId)) {
        this.streamingSince.set(chatId, stat.mtimeMs);
        this._onStreamingChange.fire({ chatId, streaming: true });
      }
      const title =
        this.titleResolver.getTitle(chatId) ??
        this.fallbackTitleCache.get(chatId) ??
        chatId.slice(0, 8);
      this._onChatActivity.fire({
        chatId,
        title,
        timestamp: this.streamingSince.get(chatId)!,
      });
    } catch {
      // File may be gone or mid-write
    }
  }

  private processFile(
    filePath: string,
    chatId: string,
    initialScan = false
  ): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        this.clearStreaming(chatId);
        return;
      }

      const prevLineCount = this.lastSeenLineCount.get(chatId) ?? 0;
      this.lastSeenLineCount.set(chatId, lines.length);

      if (!this.fallbackTitleCache.has(chatId)) {
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.role === "user") {
              const title = this.extractTitle(entry);
              if (title) {
                this.fallbackTitleCache.set(chatId, title);
                break;
              }
            }
          } catch {
            continue;
          }
        }
      }

      const lastLine = lines[lines.length - 1];
      let lastEntry: any;
      try {
        lastEntry = JSON.parse(lastLine);
      } catch {
        // Partial/invalid JSON — file may be mid-write; keep streaming state
        return;
      }

      if (
        lastEntry.role === "user" &&
        lines.length > prevLineCount &&
        prevLineCount > 0
      ) {
        const messageText = this.extractMessageText(lastEntry) ?? "";
        this._onUserMessage.fire({ chatId, messageText });
        // Model is about to generate — mark as streaming
        if (!this.streamingSince.has(chatId)) {
          this.streamingSince.set(chatId, Date.now());
          this._onStreamingChange.fire({ chatId, streaming: true });
        }
        return;
      }

      if (lastEntry.role === "assistant") {
        const stat = fs.statSync(filePath);
        const streamStart = this.streamingSince.get(chatId);
        const timestamp = streamStart ?? stat.mtimeMs;
        const title =
          this.titleResolver.getTitle(chatId) ??
          this.fallbackTitleCache.get(chatId) ??
          chatId.slice(0, 8);

        this._onAssistantMessage.fire({
          chatId,
          title,
          timestamp,
        });
        this.clearStreaming(chatId);
        return;
      }

      if (initialScan) {
        // During initial scan, also register chats where the user sent the
        // last message — the cache may still be warm from a prior assistant
        // response. Use the file mtime as the best-available timestamp.
        const stat = fs.statSync(filePath);
        const title =
          this.titleResolver.getTitle(chatId) ??
          this.fallbackTitleCache.get(chatId) ??
          chatId.slice(0, 8);
        this._onAssistantMessage.fire({
          chatId,
          title,
          timestamp: stat.mtimeMs,
        });
        this.clearStreaming(chatId);
        return;
      }

      this.clearStreaming(chatId);
    } catch (err) {
      this.log.appendLine(`[TranscriptWatcher] Error processing ${chatId}: ${err}`);
    }
  }

  private clearStreaming(chatId: string): void {
    if (this.streamingSince.has(chatId)) {
      this.streamingSince.delete(chatId);
      this._onStreamingChange.fire({ chatId, streaming: false });
    }
  }

  private extractMessageText(entry: any): string | undefined {
    try {
      const content = entry.message?.content;
      if (!Array.isArray(content)) {
        return undefined;
      }
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          let text = block.text;
          const userQueryMatch = text.match(
            /<user_query>\s*([\s\S]*?)\s*<\/user_query>/
          );
          if (userQueryMatch) {
            text = userQueryMatch[1];
          }
          text = text.replace(/<[^>]+>/g, "").trim();
          if (text.length > 0) {
            return text;
          }
        }
      }
    } catch {
      // Malformed entry
    }
    return undefined;
  }

  private extractTitle(entry: any): string | undefined {
    try {
      const content = entry.message?.content;
      if (!Array.isArray(content)) {
        return undefined;
      }

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          let text = block.text;

          const userQueryMatch = text.match(
            /<user_query>\s*([\s\S]*?)\s*<\/user_query>/
          );
          if (userQueryMatch) {
            text = userQueryMatch[1];
          }

          text = text.replace(/<[^>]+>/g, "").trim();
          if (text.length > 0) {
            return text.length > 60 ? text.slice(0, 57) + "..." : text;
          }
        }
      }
    } catch {
      // Malformed entry
    }
    return undefined;
  }

  dispose(): void {
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval);
      this.rescanInterval = undefined;
    }

    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];

    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();

    for (const t of this.throttleTimers.values()) {
      clearTimeout(t.timer);
    }
    this.throttleTimers.clear();

    this._onAssistantMessage.dispose();
    this._onChatActivity.dispose();
    this._onStreamingChange.dispose();
    this._onUserMessage.dispose();
  }
}
