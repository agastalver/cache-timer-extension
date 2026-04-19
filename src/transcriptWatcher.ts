import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChatTitleResolver } from "./chatTitleResolver";
import { getCursorHome, isWSL } from "./hostPaths";

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

/** Bytes read from the end of a transcript to extract the last JSONL line. */
const TAIL_READ_WINDOW = 512 * 1024;
/** Bytes read from the start when scanning for the initial user message (title). */
const HEAD_READ_WINDOW = 64 * 1024;
/** After this many ms of no file activity, per-chat state is evicted. */
const EVICTION_IDLE_MS = 60 * 60 * 1000;
/** Streaming must complete within this window or we clear the flag. */
const STREAMING_TIMEOUT_MS = 5 * 60 * 1000;

export class TranscriptWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private throttleTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: boolean }
  >();
  private fallbackTitleCache = new Map<string, string>();
  private streamingSince = new Map<string, number>();
  private lastSeenSize = new Map<string, number>();
  private lastSeenMtime = new Map<string, number>();
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
    return parts.map((segment) => segment.replace(/:$/, "").replace(/\./g, "-")).join("-");
  }

  private resolveTranscriptDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    let workspacePath = folders[0].uri.fsPath;

    if (isWSL()) {
      const distro = process.env.WSL_DISTRO_NAME ?? "Ubuntu";
      workspacePath = `//wsl.localhost/${distro}${workspacePath}`;
      this.log.appendLine(`[TranscriptWatcher] WSL detected, distro=${distro}`);
    }

    const slug = this.workspacePathToSlug(workspacePath);
    const cursorHome = getCursorHome(this.log);

    this.log.appendLine(`[TranscriptWatcher] Workspace path: ${workspacePath}`);
    this.log.appendLine(`[TranscriptWatcher] Computed slug: ${slug}`);

    const primary = path.join(cursorHome, "projects", slug, "agent-transcripts");
    if (fs.existsSync(primary)) {
      return primary;
    }

    // Fallback: scan projects/ for a directory whose name ends with the
    // workspace-path slug portion. Handles UNC prefix variations (wsl$ vs
    // wsl.localhost) and other naming edge cases.
    const localSlug = this.workspacePathToSlug(folders[0].uri.fsPath);
    const projectsDir = path.join(cursorHome, "projects");
    try {
      if (fs.existsSync(projectsDir)) {
        for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            continue;
          }
          if (entry.name.endsWith(localSlug)) {
            const candidate = path.join(projectsDir, entry.name, "agent-transcripts");
            if (fs.existsSync(candidate)) {
              this.log.appendLine(`[TranscriptWatcher] Fallback match: ${entry.name}`);
              return candidate;
            }
          }
        }
      }
    } catch (err) {
      this.log.appendLine(`[TranscriptWatcher] Fallback scan error: ${err}`);
    }

    return primary;
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
   * Also evicts per-chat state for chats that have been idle for a long time.
   */
  private rescan(): void {
    if (!this._transcriptDir || !fs.existsSync(this._transcriptDir)) {
      return;
    }

    const now = Date.now();
    for (const [chatId, since] of this.streamingSince) {
      if (now - since > STREAMING_TIMEOUT_MS) {
        this.log.appendLine(`[TranscriptWatcher] Streaming timeout for ${chatId} (${Math.round((now - since) / 1000)}s)`);
        this.clearStreaming(chatId);
      }
    }

    const seen = new Set<string>();

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
        seen.add(entry.name);

        try {
          const stat = fs.statSync(jsonlPath);
          const prevSize = this.lastSeenSize.get(entry.name) ?? 0;
          const ageMs = now - stat.mtimeMs;
          // Only reprocess when the file has actually changed or is very
          // fresh. Avoids re-reading dozens of inert transcripts every 10s.
          if (stat.size !== prevSize || ageMs < 15_000) {
            this.processFile(jsonlPath, entry.name);
          }
        } catch {
          // File may be gone
        }
      }
    } catch {
      // Directory may have been removed
    }

    this.evictStaleState(seen, now);
  }

  /**
   * Drop per-chat state for chats whose transcript file has disappeared or
   * hasn't been touched in a long time. Without this, every long-running
   * session would accumulate state for every chat that has ever existed in
   * the workspace.
   */
  private evictStaleState(seenChatIds: Set<string>, now: number): void {
    const maybeEvict = (chatId: string): void => {
      if (!seenChatIds.has(chatId)) {
        this.forgetChat(chatId);
        return;
      }
      const lastTouch = this.lastSeenMtime.get(chatId);
      if (lastTouch !== undefined && now - lastTouch > EVICTION_IDLE_MS) {
        this.forgetChat(chatId);
      }
    };

    for (const id of Array.from(this.lastSeenSize.keys())) {
      maybeEvict(id);
    }
    for (const id of Array.from(this.fallbackTitleCache.keys())) {
      maybeEvict(id);
    }
  }

  private forgetChat(chatId: string): void {
    this.lastSeenSize.delete(chatId);
    this.lastSeenMtime.delete(chatId);
    this.fallbackTitleCache.delete(chatId);
    this.clearStreaming(chatId);

    const debounce = this.debounceTimers.get(chatId);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(chatId);
    }
    const throttle = this.throttleTimers.get(chatId);
    if (throttle) {
      clearTimeout(throttle.timer);
      this.throttleTimers.delete(chatId);
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
      const stat = fs.statSync(filePath);
      this.lastSeenMtime.set(chatId, stat.mtimeMs);

      const prevSize = this.lastSeenSize.get(chatId) ?? 0;
      this.lastSeenSize.set(chatId, stat.size);

      if (stat.size === 0) {
        this.clearStreaming(chatId);
        return;
      }

      // Scan for an initial title once — only cheap-read the head of the
      // file, not the entire transcript.
      if (!this.fallbackTitleCache.has(chatId)) {
        const title = this.readInitialTitle(filePath);
        if (title) {
          this.fallbackTitleCache.set(chatId, title);
        }
      }

      const lastLine = this.readLastLine(filePath, stat.size);
      if (!lastLine) {
        this.clearStreaming(chatId);
        return;
      }

      let lastEntry: any;
      try {
        lastEntry = JSON.parse(lastLine);
      } catch {
        // Partial/invalid JSON — file may be mid-write; keep streaming state
        return;
      }

      if (
        lastEntry.role === "user" &&
        stat.size > prevSize &&
        prevSize > 0
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

  /**
   * Read the last complete line of a JSONL file without loading the whole
   * thing. Returns `undefined` if the last line is truncated by the tail
   * window (caller treats this like a parse failure and waits for the next
   * event).
   */
  private readLastLine(filePath: string, size: number): string | undefined {
    if (size <= 0) {
      return undefined;
    }
    const start = Math.max(0, size - TAIL_READ_WINDOW);
    const length = size - start;

    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) {
          break;
        }
        read += n;
      }
      let raw = buffer.subarray(0, read).toString("utf-8");

      // Strip trailing newlines.
      let end = raw.length;
      while (end > 0 && (raw[end - 1] === "\n" || raw[end - 1] === "\r")) {
        end--;
      }
      if (end === 0) {
        return undefined;
      }
      raw = raw.slice(0, end);

      const lastNl = raw.lastIndexOf("\n");
      if (lastNl === -1) {
        // Last line extends before the tail window — skip this round.
        if (start > 0) {
          return undefined;
        }
        return raw;
      }
      return raw.slice(lastNl + 1);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Peek at the first N bytes of a transcript to extract the first user
   * message for use as a fallback title. Much cheaper than reading the whole
   * file and called at most once per chat (the result is cached).
   */
  private readInitialTitle(filePath: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const buffer = Buffer.allocUnsafe(HEAD_READ_WINDOW);
      const read = fs.readSync(fd, buffer, 0, HEAD_READ_WINDOW, 0);
      if (read <= 0) {
        return undefined;
      }
      const raw = buffer.subarray(0, read).toString("utf-8");

      const lastNl = raw.lastIndexOf("\n");
      // If we read the whole file it may not end with a newline; otherwise the
      // last line is almost certainly truncated and should be skipped.
      const usable = read < HEAD_READ_WINDOW ? raw : lastNl === -1 ? "" : raw.slice(0, lastNl);

      for (const line of usable.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry.role === "user") {
            const title = this.extractTitle(entry);
            if (title) {
              return title;
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
    return undefined;
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
