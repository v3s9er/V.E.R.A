import type { FsEntry, ScreenFrame, ScreenSize, ShellResult } from '@mr-robot/shared';
import { launchApp } from './apps.js';
import * as files from './files.js';
import * as input from './input.js';
import * as screen from './screen.js';
import { runShell, type ShellOptions } from './shell.js';

/**
 * The unified Computer API. This is the single surface used by:
 *   - the WebSocket RPC handlers,
 *   - the AI tool executor,
 *   - plugins (via their context).
 *
 * Keeping one facade means every consumer shares the same safety and
 * resource-lifecycle behavior.
 */
export interface Computer {
  shell: typeof runShell;
  fs: {
    list: typeof files.listFiles;
    read: typeof files.readFileText;
    write: typeof files.writeFileText;
    delete: typeof files.deletePath;
    move: typeof files.movePath;
    exists: typeof files.exists;
  };
  app: { launch: typeof launchApp };
  input: {
    move: typeof input.moveMouse;
    click: typeof input.clickMouse;
    scroll: typeof input.scrollMouse;
    type: typeof input.typeText;
    key: typeof input.keyPress;
  };
  screen: { capture: typeof screen.captureScreen; size: typeof screen.screenSize };
}

export const computer: Computer = {
  shell: (command: string, opts?: ShellOptions) => runShell(command, opts),
  fs: {
    list: files.listFiles,
    read: files.readFileText,
    write: files.writeFileText,
    delete: files.deletePath,
    move: files.movePath,
    exists: files.exists,
  },
  app: { launch: launchApp },
  input: {
    move: input.moveMouse,
    click: input.clickMouse,
    scroll: input.scrollMouse,
    type: input.typeText,
    key: input.keyPress,
  },
  screen: { capture: screen.captureScreen, size: screen.screenSize },
};

export type { FsEntry, ScreenFrame, ScreenSize, ShellResult };
