import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const DESKTOP_DISPLAY_NAME = 'V.E.R.A';
export const DESKTOP_PROFILE_DIRECTORY = 'mr-robot-desktop';
export const DESKTOP_LOGIN_ITEM_NAME = 'electron.app.Mr.Robot';

export function configureDesktopBranding(app) {
  // Pin the existing profile before changing Electron's display name. This
  // preserves encrypted PC credentials, browser sessions and desktop settings.
  const explicitUserData = app.commandLine?.hasSwitch('user-data-dir')
    ? app.commandLine.getSwitchValue('user-data-dir') : undefined;
  const userData = explicitUserData
    ? resolve(explicitUserData)
    : app.isPackaged
    ? resolve(app.getPath('appData'), DESKTOP_PROFILE_DIRECTORY)
    : app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setName(DESKTOP_DISPLAY_NAME);
}
