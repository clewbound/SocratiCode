// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import * as vscode from "vscode";
import { registerCommands } from "./commands.js";
import { registerMcpProvider } from "./mcpProvider.js";
import { initOutput, log } from "./output.js";
import { registerSidebar } from "./sidebar.js";
import { registerStatusBar } from "./statusBar.js";

const FIRST_RUN_KEY = "socraticode.firstRunWalkthroughShown";

/**
 * Extension entry point. Wires up all the building blocks in the order
 * they need: output channel first (so other modules can log during their
 * own setup), then MCP provider (the most important contribution), then
 * sidebar / status bar / commands (UI), then the first-run walkthrough.
 *
 * Note: the entire activation function should stay synchronous from
 * VS Code's point of view (it returns a Promise but every step is fast).
 * Anything slow (network, disk reads) is deferred to when the user
 * actually triggers it via a command.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initOutput(context);
  log("SocratiCode extension activating");

  registerMcpProvider(context);
  const sidebar = registerSidebar(context);
  registerStatusBar(context);
  registerCommands(context, sidebar);

  // Show the walkthrough on first install. We use globalState rather than
  // a setting so it's per-machine, not per-workspace.
  const shown = context.globalState.get<boolean>(FIRST_RUN_KEY, false);
  if (!shown) {
    void context.globalState.update(FIRST_RUN_KEY, true);
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#socraticode.gettingStarted`,
      false,
    );
  }

  log("SocratiCode extension activated");
}

export function deactivate(): void {
  // Subscriptions are disposed automatically by VS Code via
  // context.subscriptions. No additional cleanup needed today.
}
