import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { MrRobotClient } from '../rpc';
import { wsUrl } from '../rpc';
import type { SavedPc } from '../types';
import { parsePairingPayload } from '../rpc';
import { exchangePin, loadPcs, removePc, savePcs, setLastPcId, upsertPc } from '../pcs';
import { colors, radius, shadow } from '../theme';

export function PcListScreen({
  client,
  onConnected,
}: {
  client: MrRobotClient;
  onConnected: (pc: SavedPc) => void;
}) {
  const [pcs, setPcs] = useState<SavedPc[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [name, setName] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanHandled, setScanHandled] = useState(false);
  const [scanReady, setScanReady] = useState(false);
  const [scanError, setScanError] = useState('');

  useEffect(() => {
    void loadPcs().then(setPcs);
  }, []);

  const connect = async (pc: SavedPc): Promise<boolean> => {
    setConnectingId(pc.id);
    setError('');
    const candidates = [...new Set([pc.activeHost, pc.host, ...(pc.hosts ?? [])].filter((value): value is string => Boolean(value)))];
    let lastError = '연결할 주소가 없습니다.';
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      try {
        await client.connect(wsUrl(`${candidate}:${pc.port}`), pc.secret, index < candidates.length - 1 ? 2500 : 8000);
        let refreshedHosts = pc.hosts ?? [pc.host];
        try {
          const info = await client.call('pairing.info', {}) as { host?: string; hosts?: string[] };
          refreshedHosts = [...new Set([info.host, ...(info.hosts ?? []), ...refreshedHosts].filter((value): value is string => Boolean(value)))];
        } catch { /* 연결 자체는 유효하므로 주소 새로고침 실패는 무시 */ }
        const connectedPc = { ...pc, hosts: refreshedHosts, activeHost: candidate };
        const saved = (await loadPcs()).map((item) => item.id === pc.id ? connectedPc : item);
        await savePcs(saved);
        await setLastPcId(pc.id);
        setConnectingId(null);
        onConnected(connectedPc);
        return true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    setError(`${pc.name} 연결 실패: ${lastError}\nPC 주소와 네트워크 연결 상태를 확인하세요.`);
    setConnectingId(null);
    return false;
  };

  const addPc = async (): Promise<void> => {
    if (busy || !hostPort.trim() || pin.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      const secret = await exchangePin(hostPort, pin, name.trim() || '모바일');
      const pc: Omit<SavedPc, 'id' | 'addedAt'> = {
        name: name.trim() || hostPort.trim(),
        host: hostPort.split(':')[0] || hostPort.trim(),
        port: Number(hostPort.split(':')[1] ?? 8787),
        secret,
      };
      const next = await upsertPc(await loadPcs(), pc);
      await savePcs(next);
      setPcs(next);
      setShowAdd(false);
      setName('');
      setHostPort('');
      setPin('');
      await connect(next[next.length - 1]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onScan = async (data: string): Promise<void> => {
    if (scanHandled) return;
    const payload = parsePairingPayload(data);
    if (!payload) {
      setScanError('Mr.Robot 페어링 QR이 아닙니다. PC 앱의 설정 → 모바일 연결 QR을 비춰주세요.');
      setScanHandled(true);
      return;
    }
    setScanHandled(true);
    setScanError('PC 연결 정보를 확인하는 중…');
    setError('');
    try {
      const hosts = [...new Set([payload.host, ...(payload.hosts ?? [])])];
      const secret = payload.pin
        ? await exchangePin(`${payload.host}:${payload.port}`, payload.pin, `모바일 (${payload.host})`)
        : payload.secret;
      if (!secret) throw new Error('QR에 연결 정보가 없습니다.');
      const next = await upsertPc(await loadPcs(), {
        name: `PC (${payload.host})`,
        host: payload.host,
        hosts,
        port: payload.port,
        secret,
      });
      await savePcs(next);
      setPcs(next);
      const connected = await connect(next[next.length - 1]);
      if (connected) setShowScan(false);
      else {
        setScanError('주소는 저장했지만 지금 연결되지 않습니다. PC 주소와 네트워크 상태를 확인하세요.');
        setScanHandled(false);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
      setScanHandled(false);
    }
  };

  const deletePc = async (id: string): Promise<void> => {
    const next = await removePc(await loadPcs(), id);
    await savePcs(next);
    setPcs(next);
  };

  const openScanner = async (): Promise<void> => {
    setError('');
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError('카메라 권한이 필요합니다. 설정에서 허용해 주세요.');
        return;
      }
    }
    setScanHandled(false);
    setScanReady(false);
    setScanError('');
    setShowScan(true);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.logo}>Mr.Robot</Text>
        <Text style={styles.sub}>{pcs.length ? '연결할 PC를 선택하세요' : '모바일 연결 마법사'}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {pcs.length === 0 && (
          <View style={styles.wizard}>
            <Text style={styles.wizardTitle}>앱 준비 완료</Text>
            <Text style={styles.wizardCopy}>파일 전송·QR 카메라·보안 저장소 모듈은 앱에 포함되어 별도 설치가 필요 없습니다.</Text>
            <View style={styles.step}><Text style={styles.stepNo}>1</Text><View><Text style={styles.stepTitle}>PC 설치 마법사 완료</Text><Text style={styles.stepCopy}>PC에서 의존성 검사 후 Mr.Robot을 실행합니다.</Text></View></View>
            <View style={styles.step}><Text style={styles.stepNo}>2</Text><View><Text style={styles.stepTitle}>QR 또는 PIN으로 신뢰 연결</Text><Text style={styles.stepCopy}>Google 비밀번호나 AI API 키를 공유하지 않습니다.</Text></View></View>
            <View style={styles.step}><Text style={styles.stepNo}>3</Text><View><Text style={styles.stepTitle}>PC 명령·단일 모델·복합 트리 선택</Text><Text style={styles.stepCopy}>연결 직후 대화 화면에서 자유롭게 전환합니다.</Text></View></View>
          </View>
        )}

        {pcs.map((pc) => (
          <View key={pc.id} style={styles.pcCard}>
            <View style={styles.pcInfo}>
              <Text style={styles.pcIcon}>🖥️</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.pcName}>{pc.name}</Text>
                <Text style={styles.pcAddr}>
                  {pc.activeHost ?? pc.host}:{pc.port}
                </Text>
                <Text style={styles.pcRoute}>저장된 접속 주소 {(pc.hosts?.length ?? 1).toLocaleString()}개</Text>
              </View>
            </View>
            <View style={styles.pcActions}>
              <TouchableOpacity
                style={[styles.connectBtn, connectingId === pc.id && styles.btnDisabled]}
                onPress={() => void connect(pc)}
                disabled={connectingId !== null}
              >
                {connectingId === pc.id ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.connectText}>연결</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteBtn} onPress={() => void deletePc(pc.id)}>
                <Text style={styles.deleteText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.mainButtons}>
          <TouchableOpacity style={styles.bigBtn} onPress={() => setShowAdd(true)}>
            <Text style={styles.bigBtnText}>＋ PIN으로 PC 추가</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bigBtn, styles.bigBtnAlt]} onPress={() => void openScanner()}>
            <Text style={styles.bigBtnText}>▣ QR 코드 스캔</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>PC 추가</Text>
            <Text style={styles.label}>PC 이름 (선택)</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="예: 서재 데스크톱"
              placeholderTextColor={colors.faint}
            />
            <Text style={styles.label}>PC 주소</Text>
            <Text style={styles.addressHelp}>PC 앱의 설정 → 모바일 연결에 표시된 주소를 그대로 입력하세요. 예: 192.168.0.10:8787</Text>
            <TextInput
              style={styles.input}
              value={hostPort}
              onChangeText={setHostPort}
              placeholder="192.168.0.10:8787"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>PIN 코드 (PC 화면에 표시)</Text>
            <TextInput
              style={[styles.input, styles.pinInput]}
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.bigBtn, { flex: 1 }]} onPress={() => setShowAdd(false)}>
                <Text style={styles.bigBtnText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bigBtn, styles.bigBtnAlt, { flex: 1 }, busy && styles.btnDisabled]}
                onPress={() => void addPc()}
                disabled={busy || !hostPort.trim() || pin.length !== 6}
              >
                <Text style={styles.bigBtnText}>{busy ? '등록 중…' : '등록 및 연결'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showScan} animationType="slide" onRequestClose={() => setShowScan(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={{ flex: 1 }}
            onCameraReady={() => setScanReady(true)}
            onMountError={(event) => setScanError(`카메라를 열지 못했습니다: ${event.message}`)}
            onBarcodeScanned={scanReady && !scanHandled ? (res) => void onScan(res.data) : undefined}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={styles.scanBar}>
            {!scanReady ? <ActivityIndicator color={colors.accent2} /> : null}
            <Text style={styles.scanHint}>{scanError || 'PC 앱의 설정 → 모바일 연결에 있는 QR만 비추세요.'}</Text>
            {scanHandled && scanError && !scanError.includes('확인하는 중') ? <TouchableOpacity style={[styles.bigBtn, styles.bigBtnAlt]} onPress={() => { setScanError(''); setScanHandled(false); }}><Text style={styles.bigBtnText}>다시 스캔</Text></TouchableOpacity> : null}
            <TouchableOpacity style={styles.bigBtn} onPress={() => setShowScan(false)}>
              <Text style={styles.bigBtnText}>닫기</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 70, paddingHorizontal: 24, paddingBottom: 16 },
  logo: {
    fontSize: 34,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: 0.5,
  },
  sub: { color: colors.dim, marginTop: 4, fontSize: 15 },
  list: { padding: 24, paddingBottom: 60, gap: 14 },
  empty: { color: colors.faint, textAlign: 'center', lineHeight: 22, marginTop: 30 },
  wizard: { gap: 10, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.card },
  wizardTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  wizardCopy: { color: colors.faint, fontSize: 12.5, lineHeight: 18, marginBottom: 4 },
  step: { flexDirection: 'row', gap: 11, alignItems: 'center', padding: 11, borderRadius: radius.md, backgroundColor: colors.inputBg },
  stepNo: { width: 26, height: 26, lineHeight: 26, textAlign: 'center', borderRadius: 13, overflow: 'hidden', color: '#fff', backgroundColor: colors.accent, fontWeight: '800' },
  stepTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  stepCopy: { color: colors.faint, fontSize: 11, marginTop: 2 },
  pcCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 16,
    ...shadow,
  },
  pcInfo: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  pcIcon: { fontSize: 26 },
  pcName: { color: colors.text, fontWeight: '700', fontSize: 16 },
  pcAddr: { color: colors.faint, fontSize: 12.5, marginTop: 2 },
  pcRoute: { color: colors.accent2, fontSize: 10.5, marginTop: 3 },
  pcActions: { flexDirection: 'row', gap: 8 },
  connectBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minWidth: 66,
    alignItems: 'center',
  },
  connectText: { color: '#fff', fontWeight: '700' },
  deleteBtn: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  deleteText: { color: colors.dim },
  btnDisabled: { opacity: 0.5 },
  mainButtons: { gap: 12, marginTop: 10 },
  bigBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
  },
  bigBtnAlt: { backgroundColor: 'rgba(34,211,238,0.15)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.4)' },
  bigBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  error: { color: colors.err, fontSize: 13, lineHeight: 19 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(4,6,12,0.7)',
    justifyContent: 'center',
    padding: 24,
  },
  modal: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 22,
    gap: 8,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  label: { color: colors.dim, fontSize: 13, fontWeight: '600', marginTop: 6 },
  addressHelp: { color: colors.accent2, fontSize: 11.5, lineHeight: 17 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
  },
  pinInput: { letterSpacing: 8, fontSize: 20, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  scanBar: {
    padding: 20,
    backgroundColor: '#0b0f1a',
    gap: 14,
    alignItems: 'center',
  },
  scanHint: { color: colors.dim, fontSize: 14 },
});
