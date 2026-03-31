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

export class TranscriptWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private throttleTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: boolean }
  >();
  private fallbackTitleCache = new Map<string, string>();

  private readonly _onAssistantMessage =
    new vscode.EventEmitter<TranscriptEvent>();
  readonly onAssistantMessage = this._onAssistantMessage.event;

  private readonly _onChatActivity =
    new vscode.EventEmitter<TranscriptEvent>();
  readonly onChatActivity = this._onChatActivity.event;

  private transcriptDir: string | undefined;

  constructor(private readonly titleResolver: ChatTitleResolver) {}

  async start(): Promise<void> {
    this.transcriptDir = this.resolveTranscriptDir();
    if (!this.transcriptDir) {
      return;
    }

    if (!fs.existsSync(this.transcriptDir)) {
      return;
    }

    await this.scanExisting();
    this.watchDirectory(this.transcriptDir);
  }

  private resolveTranscriptDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    const workspacePath = folders[0].uri.fsPath;
    const slug = workspacePath.replace(/^\//, "").replace(/\//g, "-");
    const cursorHome = path.join(os.homedir(), ".cursor");

    return path.join(cursorHome, "projects", slug, "agent-transcripts");
  }

  private async scanExisting(): Promise<void> {
    if (!this.transcriptDir) {
      return;
    }

    try {
      const entries = fs.readdirSync(this.transcriptDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const jsonlPath = path.join(
          this.transcriptDir,
          entry.name,
          `${entry.name}.jsonl`
        );
        if (fs.existsSync(jsonlPath)) {
          this.processFile(jsonlPath, entry.name);
        }
      }
    } catch {
      // Directory may not exist yet
    }
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
    } catch {
      // Watch may fail if directory doesn't exist
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
      const title =
        this.titleResolver.getTitle(chatId) ??
        this.fallbackTitleCache.get(chatId) ??
        chatId.slice(0, 8);
      this._onChatActivity.fire({
        chatId,
        title,
        timestamp: stat.mtimeMs,
      });
    } catch {
      // File may be gone or mid-write
    }
  }

  private processFile(filePath: string, chatId: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        return;
      }

      // Build fallback title from first user message if not cached
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
        return;
      }

      if (lastEntry.role === "assistant") {
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
      }
    } catch {
      // File may be mid-write
    }
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
  }
}
