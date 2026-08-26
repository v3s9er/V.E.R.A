import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { MrRobotClient } from './src/rpc';
import type { SavedPc } from './src/types';
import { PcListScreen } from './src/screens/PcListScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { colors } from './src/theme';

export default function App() {
  const clientRef = useRef<MrRobotClient | null>(null);
  if (!clientRef.current) clientRef.current = new MrRobotClient();
  const client = clientRef.current;

  const [activePc, setActivePc] = useState<SavedPc | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    client.onClose = () => setDisconnected(true);
    return () => client.close();
  }, [client]);

  const showList = !activePc || disconnected;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      {showList ? (
        <PcListScreen
          client={client}
          onConnected={(pc) => {
            setDisconnected(false);
            setActivePc(pc);
          }}
        />
      ) : (
        <HomeScreen
          client={client}
          pc={activePc}
          onSwitchPc={() => {
            client.close();
            setDisconnected(false);
            setActivePc(null);
          }}
        />
      )}
    </View>
  );
}
