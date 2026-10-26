import * as vscode from 'vscode';
import { StackController } from './extension/controller';
import { registerCommands } from './extension/commands';
import { EditorGit } from './extension/nativeGit';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const git = await EditorGit.activate();
  const output = vscode.window.createOutputChannel('StackHub');
  const controller = new StackController(context, git, output);
  context.subscriptions.push(output, controller);
  registerCommands(controller, context.extension.id);
  await controller.start();
}
