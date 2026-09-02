import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { MrRobotClient } from './src/rpc';
import type { SavedPc } from './src/types';
import { PcListScreen } from './src/screens/PcListScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { colors } from './src/theme';
import { connectionOrigins, getLastPcId, loadPcs, parsePcAddress, savePcs, setLastPcId } from './src/pcs';
import { wsUrl } from './src/rpc';

export type AppConnectionState = 'connected' | 'reconnecting' | 'offline';

export default function App() {
  const clientRef = useRef<MrRobotClient | null>(null);
  if (!clientRef.current) clientRef.current = new MrRobotClient();
  const client = clientRef.current;

  const [activePc, setActivePc] = useState<SavedPc | null>(null);
  const [pcList, setPcList] = useState<SavedPc[]>([]);
  const [connectionState, setConnectionState] = useState<AppConnectionState>('offline');
  const activePcRef = useRef<SavedPc | null>(null);
  const reconnectNowRef = useRef<() => void>(() => undefined);
  const selectExecutionPcRef = useRef<(pc: SavedPc) => void>(() => undefined);

  useEffect(() => { activePcRef.current = activePc; }, [activePc]);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let currentAppState = AppState.currentState;
    let operationGeneration = 0;
    let connectPromise: Promise<boolean> | null = null;
    let reconnectRequested = false;

    const clearReconnect = (): void => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const connectPc = (pc: SavedPc): Promise<boolean> => {
      if (connectPromise) return connectPromise;
      if (!mounted || currentAppState !== 'active') return Promise.resolve(false);
      clearReconnect();
      setConnectionState('reconnecting');
      const candidates = connectionOrigins(pc);
      const generation = ++operationGeneration;
      const isCurrent = (): boolean => mounted && currentAppState === 'active' && generation === operationGeneration && activePcRef.current?.id === pc.id;
      let attempt!: Promise<boolean>;
      attempt = (async (): Promise<boolean> => {
      try {
        let lastError: unknown = new Error('연결할 주소가 없습니다.');
        for (let index = 0; index < candidates.length; index++) {
          if (!isCurrent()) return false;
          const origin = candidates[index];
          try {
            await client.connect(
              wsUrl(origin),
              pc.secret,
              index < candidates.length - 1 ? 3500 : 8000,
              pc.cloudflareAccess,
              pc.cloudflareAccessOrigin,
            );
            if (!isCurrent()) { client.close(); return false; }
            const endpoint = parsePcAddress(origin, pc.port, pc.protocol ?? 'http');
            const connectedPc = { ...pc, activeHost: endpoint.host, activeOrigin: endpoint.origin };
            const currentPcs = await loadPcs();
            if (!isCurrent() || !currentPcs.some((item) => item.id === pc.id)) { client.close(); return false; }
            const saved = currentPcs.map((item) => item.id === pc.id ? connectedPc : item);
            await savePcs(saved);
            if (!isCurrent()) { client.close(); return false; }
            await setLastPcId(pc.id);
            if (isCurrent()) {
              clearReconnect();
              reconnectRequested = false;
              activePcRef.current = connectedPc;
              setActivePc(connectedPc);
              setConnectionState('connected');
              reconnectAttempt = 0;
            }
            return true;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      } catch {
        if (isCurrent()) setConnectionState('offline');
        return false;
      } finally {
        if (connectPromise === attempt) {
          connectPromise = null;
          if (reconnectRequested && mounted && currentAppState === 'active' && activePcRef.current) {
            reconnectRequested = false;
            scheduleReconnect(true);
          }
        }
      }
      })();
      connectPromise = attempt;
      return attempt;
    };

    const scheduleReconnect = (immediate = false): void => {
      clearReconnect();
      const pc = activePcRef.current;
      if (!pc || !mounted || currentAppState !== 'active') return;
      if (connectPromise) { reconnectRequested = true; return; }
      const delay = immediate ? 0 : Math.min(30_000, 1000 * (2 ** Math.min(reconnectAttempt, 5)));
      reconnectAttempt += 1;
      const scheduledGeneration = ++operationGeneration;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!mounted || currentAppState !== 'active' || scheduledGeneration !== operationGeneration) return;
        const current = activePcRef.current;
        if (!current) return;
        void connectPc(current).then((ok) => { if (!ok) scheduleReconnect(false); });
      }, delay);
    };

    reconnectNowRef.current = () => scheduleReconnect(true);
    selectExecutionPcRef.current = (pc: SavedPc) => {
      if (activePcRef.current?.id === pc.id) return;
      // Invalidate the old host before closing its socket so an onClose event
      // cannot accidentally schedule the previous PC again.
      operationGeneration += 1;
      clearReconnect();
      reconnectRequested = false;
      activePcRef.current = null;
      client.close();
      activePcRef.current = pc;
      setActivePc(pc);
      setConnectionState('reconnecting');
      void setLastPcId(pc.id);
      scheduleReconnect(true);
    };
    client.onClose = () => {
      if (!mounted || currentAppState !== 'active' || !activePcRef.current) return;
      setConnectionState('reconnecting');
      scheduleReconnect(false);
    };

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      currentAppState = state;
      const foregroundGeneration = ++operationGeneration;
      clearReconnect();
      if (state !== 'active') {
        reconnectRequested = false;
        if (connectPromise) client.close();
        return;
      }
      if (!activePcRef.current) return;
      if (!client.authed) {
        scheduleReconnect(true);
        return;
      }
      void client.healthCheck().then((healthy) => {
        if (healthy || !mounted || currentAppState !== 'active' || foregroundGeneration !== operationGeneration) return;
        client.close();
        setConnectionState('reconnecting');
        scheduleReconnect(true);
      });
    });

    void Promise.all([loadPcs(), getLastPcId()]).then(([pcs, lastId]) => {
      if (mounted) setPcList(pcs);
      if (!mounted || activePcRef.current) return;
      const last = pcs.find((pc) => pc.id === lastId && pc.secret);
      if (!last) return;
      activePcRef.current = last;
      setActivePc(last);
      scheduleReconnect(true);
    });

    return () => {
      mounted = false;
      operationGeneration += 1;
      clearReconnect();
      appStateSubscription.remove();
      reconnectNowRef.current = () => undefined;
      selectExecutionPcRef.current = () => undefined;
      client.dispose();
    };
  }, [client]);

  const handleConnected = (pc: SavedPc): void => {
    activePcRef.current = pc;
    setActivePc(pc);
    setConnectionState('connected');
    void loadPcs().then(setPcList);
  };

  const openPcManager = (): void => {
    client.close();
    activePcRef.current = null;
    setActivePc(null);
    setConnectionState('offline');
  };

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        {!activePc ? (
          <PcListScreen client={client} onConnected={handleConnected} />
        ) : (
          <HomeScreen
            client={client}
            pc={activePc}
            pcs={pcList}
            connectionState={connectionState}
            onRetryConnection={() => reconnectNowRef.current()}
            onSelectPc={(pc) => selectExecutionPcRef.current(pc)}
            onManagePcs={openPcManager}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}
