import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFile } from "child_process";

const DB_REL_PATH = path.join(".cursor", "ai-tracking", "ai-code-tracking.db");
const POLL_INTERVAL_MS = 3_000;
const INITIAL_LOOKBACK_MS = 10_000;

/**
 * Polls ~/.cursor/ai-tracking/ai-code-tracking.db for recent ai_code_hashes
 * entries to detect streaming activity. Complements the TranscriptWatcher with
 * a signal that works even when fs.watch misses events.
 */
export class AiTrackingDbWatcher implements vscode.Disposable {
  private dbPath: string;
  private highWatermark = 0;
  private activeConversations = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  private readonly _onStreamingChange = new vscode.EventEmitter<{
    chatId: string;
    streaming: boolean;
  }>();
  readonly onStreamingChange = this._onStreamingChange.event;

  private readonly _onChatActivity = new vscode.EventEmitter<{
    chatId: string;
    timestamp: number;
  }>();
  readonly onChatActivity = this._onChatActivity.event;

  constructor(private readonly log: vscode.OutputChannel) {
    this.dbPath = path.join(os.homedir(), DB_REL_PATH);
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.dbPath)) {
      this.log.appendLine(
        `[AiTrackingDbWatcher] DB not found: ${this.dbPath}`
      );
      return;
    }

    this.log.appendLine(`[AiTrackingDbWatcher] Watching: ${this.dbPath}`);
    this.highWatermark = Date.now() - INITIAL_LOOKBACK_MS;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private poll(): void {
    if (this.polling) {
      return;
    }
    this.polling = true;

    const query = [
      "SELECT conversationId, MAX(timestamp) as lastTs",
      "FROM ai_code_hashes",
      "WHERE source = 'composer'",
      `  AND timestamp > ${this.highWatermark}`,
      "GROUP BY conversationId;",
    ].join(" ");

    execFile(
      "sqlite3",
      ["-separator", "|", this.dbPath, query],
      { timeout: 5_000 },
      (err, stdout) => {
        this.polling = false;

        if (err) {
          if (!String(err).includes("SQLITE_BUSY")) {
            this.log.appendLine(
              `[AiTrackingDbWatcher] Query error: ${err}`
            );
          }
          return;
        }

        const seen = new Set<string>();
        let newHighWatermark = this.highWatermark;

        for (const line of stdout.trim().split("\n")) {
          if (!line) {
            continue;
          }
          const [conversationId, lastTsStr] = line.split("|");
          if (!conversationId) {
            continue;
          }

          const lastTs = Number(lastTsStr);
          if (!Number.isFinite(lastTs)) {
            continue;
          }

          seen.add(conversationId);
          if (lastTs > newHighWatermark) {
            newHighWatermark = lastTs;
          }

          if (!this.activeConversations.has(conversationId)) {
            this.activeConversations.add(conversationId);
            this._onStreamingChange.fire({
              chatId: conversationId,
              streaming: true,
            });
          }

          this._onChatActivity.fire({
            chatId: conversationId,
            timestamp: lastTs,
          });
        }

        for (const id of this.activeConversations) {
          if (!seen.has(id)) {
            this.activeConversations.delete(id);
            this._onStreamingChange.fire({ chatId: id, streaming: false });
          }
        }

        this.highWatermark = newHighWatermark;
      }
    );
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this._onStreamingChange.dispose();
    this._onChatActivity.dispose();
  }
}
