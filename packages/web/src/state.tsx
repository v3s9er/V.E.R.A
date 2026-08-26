import { createContext, useContext } from 'react';
import { MrRobotClient } from './rpc';

export interface MrRobotContextValue {
  client: MrRobotClient;
}

export const MrRobotContext = createContext<MrRobotContextValue>({ client: new MrRobotClient() });

export function useMrRobot(): MrRobotContextValue {
  return useContext(MrRobotContext);
}
