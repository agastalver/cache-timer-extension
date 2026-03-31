import * as vscode from "vscode";

export interface ChatTimer {
  id: string;
  title: string;
  lastAssistantTime: number;
  createdAt: number;
  remainingSeconds: number;
  isExpired: boolean;
}

export class TimerManager implements vscode.Disposable {
  private timers = new Map<string, ChatTimer>();
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onTimerExpired = new vscode.EventEmitter<ChatTimer>();
  readonly onTimerExpired = this._onTimerExpired.event;

  get ttlSeconds(): number {
    return vscode.workspace
      .getConfiguration("cacheTimer")
      .get<number>("ttlSeconds", 300);
  }

  constructor() {
    this.tickInterval = setInterval(() => this.tick(), 1000);
  }

  resetTimer(chatId: string, title: string, timestamp?: number): void {
    const now = timestamp ?? Date.now();
    const existing = this.timers.get(chatId);
    this.timers.set(chatId, {
      id: chatId,
      title: title || existing?.title || chatId.slice(0, 8),
      lastAssistantTime: now,
      createdAt: existing?.createdAt ?? now,
      remainingSeconds: this.ttlSeconds,
      isExpired: false,
    });
    this._onDidChange.fire();
  }

  updateTitle(chatId: string, title: string): void {
    const timer = this.timers.get(chatId);
    if (timer && title) {
      timer.title = title;
      this._onDidChange.fire();
    }
  }

  resetAll(): void {
    this.timers.clear();
    this._onDidChange.fire();
  }

  getAll(): ChatTimer[] {
    return Array.from(this.timers.values()).sort(
      (a, b) => b.lastAssistantTime - a.lastAssistantTime
    );
  }

  getMostRecent(): ChatTimer | undefined {
    let best: ChatTimer | undefined;
    for (const t of this.timers.values()) {
      if (!best || t.lastAssistantTime > best.lastAssistantTime) {
        best = t;
      }
    }
    return best;
  }

  private tick(): void {
    let changed = false;
    const now = Date.now();
    const ttl = this.ttlSeconds;

    for (const timer of this.timers.values()) {
      const elapsed = (now - timer.lastAssistantTime) / 1000;
      const remaining = Math.max(0, ttl - elapsed);
      const newRemaining = Math.floor(remaining);
      const nowExpired = remaining <= 0;

      if (newRemaining !== timer.remainingSeconds || timer.isExpired !== nowExpired) {
        const wasActive = !timer.isExpired;
        timer.remainingSeconds = newRemaining;
        timer.isExpired = nowExpired;
        changed = true;

        if (nowExpired && wasActive) {
          this._onTimerExpired.fire(timer);
        }
      }
    }

    if (changed) {
      this._onDidChange.fire();
    }
  }

  dispose(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
    this._onDidChange.dispose();
    this._onTimerExpired.dispose();
  }
}
