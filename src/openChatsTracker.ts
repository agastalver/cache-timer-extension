import * as vscode from "vscode";

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Legacy command prefixes (pre–Cursor 3.0). Kept as fallback in case the
 * `composer.getOrderedSelectedComposerIds` command is unavailable.
 */
const LEGACY_COMMAND_PREFIXES = [
  "workbench.panel.composerChatViewPane.",
  "workbench.panel.aichat.view.",
];

export class OpenChatsTracker implements vscode.Disposable {
  private openIds: string[] = [];
  private openSet = new Set<string>();
  private pollInterval: ReturnType<typeof setInterval> | undefined;
  private log?: vscode.OutputChannel;
  private diagnosticLogged = false;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(log?: vscode.OutputChannel) {
    this.log = log;
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), 5000);
  }

  isOpen(chatId: string): boolean {
    return this.openSet.has(chatId);
  }

  getOrderedOpenIds(): string[] {
    return this.openIds;
  }

  async forcePoll(): Promise<void> {
    this.diagnosticLogged = false;
    await this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const ordered = await this.detectOpenChats();

      const changed =
        ordered.length !== this.openIds.length ||
        ordered.some((id, i) => id !== this.openIds[i]);

      if (changed) {
        this.openIds = ordered;
        this.openSet = new Set(ordered);
        this._onDidChange.fire();
      }
    } catch {
      // may fail during shutdown
    }
  }

  /**
   * Try multiple strategies in priority order and merge results.
   *
   * 1. `composer.getOrderedSelectedComposerIds` (Cursor 3.0+)
   * 2. Legacy per-chat command scanning (pre-3.0)
   */
  private async detectOpenChats(): Promise<string[]> {
    const composerIds = await this.queryComposerIds();
    const legacyIds = await this.extractLegacyChatIds();

    const merged = new Set([...composerIds, ...legacyIds]);

    this.logDiagnostics(composerIds, legacyIds);

    if (composerIds.length > 0) {
      for (const id of legacyIds) {
        if (!composerIds.includes(id)) {
          composerIds.push(id);
        }
      }
      return composerIds;
    }

    return Array.from(merged);
  }

  /**
   * Cursor 3.0+ exposes `composer.getOrderedSelectedComposerIds` which
   * returns the ordered list of currently open composer/chat IDs.
   */
  private async queryComposerIds(): Promise<string[]> {
    try {
      const result = await vscode.commands.executeCommand<unknown>(
        "composer.getOrderedSelectedComposerIds"
      );

      if (Array.isArray(result)) {
        return result.filter(
          (v): v is string => typeof v === "string" && UUID_PATTERN.test(v)
        );
      }

      if (typeof result === "string") {
        const match = result.match(UUID_PATTERN);
        if (match) {
          return [match[0]];
        }
      }
    } catch {
      // Command not available (older Cursor)
    }
    return [];
  }

  /**
   * Legacy detection: scan registered commands for per-chat UUIDs
   * (pre–Cursor 3.0 pattern).
   */
  private async extractLegacyChatIds(): Promise<string[]> {
    try {
      const commands = await vscode.commands.getCommands(true);
      const ids = new Set<string>();
      for (const cmd of commands) {
        for (const prefix of LEGACY_COMMAND_PREFIXES) {
          if (cmd.startsWith(prefix)) {
            const match = cmd.match(UUID_PATTERN);
            if (match) {
              ids.add(match[0]);
            }
          }
        }
      }
      return Array.from(ids);
    } catch {
      return [];
    }
  }

  private logDiagnostics(
    composerIds: string[],
    legacyIds: string[]
  ): void {
    if (this.diagnosticLogged) {
      return;
    }
    this.diagnosticLogged = true;

    const lines = [
      `[OpenChatsTracker] Diagnostic:`,
      `  composer.getOrderedSelectedComposerIds => [${composerIds.join(", ")}]`,
      `  legacy command scan => [${legacyIds.join(", ")}]`,
    ];

    const block = lines.join("\n");
    console.log(block);
    if (this.log) {
      this.log.appendLine(block);
    }
  }

  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this._onDidChange.dispose();
  }
}
