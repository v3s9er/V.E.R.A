import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraViewProps } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MrRobotClient } from '../rpc';
import { pairingOrigins, wsUrl } from '../rpc';
import type { PairingPayload, SavedPc } from '../types';
import { parsePairingPayload } from '../rpc';
import { connectionOrigins, exchangePin, exchangePinAcrossOrigins, getLastPcId, loadPcs, parsePcAddress, removePc, savePcs, setLastPcId, upsertPc } from '../pcs';
import { colors, radius, shadow } from '../theme';

const PAIRING_PIN_PATTERN = /^(?:\d{6}|\d{12})$/;
const QR_SCANNER_SETTINGS: NonNullable<CameraViewProps['barcodeScannerSettings']> = { barcodeTypes: ['qr'] };
const INVALID_QR_HINT_MS = 1_800;

export function PcListScreen({
  client,
  onConnected,
}: {
  client: MrRobotClient;
  onConnected: (pc: SavedPc) => void;
}) {
  const insets = useSafeAreaInsets();
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
  const [scannerKey, setScannerKey] = useState(0);
  const [detectedPayload, setDetectedPayload] = useState<PairingPayload | null>(null);
  const [scanConnecting, setScanConnecting] = useState(false);
  const connectGeneration = useRef(0);
  const deletedIds = useRef(new Set<string>());
  const scanLockRef = useRef(false);
  const scanConnectingRef = useRef(false);
  const scannerSessionRef = useRef(0);
  const invalidHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadPcs().then(setPcs);
    return () => {
      if (invalidHintTimerRef.current) clearTimeout(invalidHintTimerRef.current);
    };
  }, []);

  const connect = async (pc: SavedPc): Promise<boolean> => {
    const generation = ++connectGeneration.current;
    deletedIds.current.delete(pc.id);
    const isCurrent = (): boolean => generation === connectGeneration.current && !deletedIds.current.has(pc.id);
    setConnectingId(pc.id);
    setError('');
    if (!pc.secret) {
      setError(`${pc.name}: 저장된 자격증명을 읽지 못했습니다. PIN 또는 QR로 다시 등록해 주세요.`);
      setConnectingId(null);
      return false;
    }
    const candidates = connectionOrigins(pc);
    let lastError = '보안 접속 주소가 없습니다. PC에서 Quick Link를 시작하거나 Tailscale 주소로 다시 등록하세요.';
    for (let index = 0; index < candidates.length; index++) {
      if (!isCurrent()) return false;
      const candidateOrigin = candidates[index];
      try {
        await client.connect(wsUrl(candidateOrigin), pc.secret, index < candidates.length - 1 ? 2500 : 8000);
        if (!isCurrent()) { client.close(); return false; }
        const candidate = parsePcAddress(candidateOrigin, pc.port, pc.protocol ?? 'http');
        let refreshedHosts = pc.hosts ?? [];
        let refreshedPort = pc.port;
        try {
          const info = await client.call('pairing.info', {}) as { host?: string; hosts?: string[]; port?: number };
          refreshedHosts = [...new Set([info.host, ...(info.hosts ?? []), ...refreshedHosts].filter((value): value is string => Boolean(value)))];
          if (Number.isInteger(info.port) && Number(info.port) > 0 && Number(info.port) <= 65535) refreshedPort = Number(info.port);
        } catch { /* 연결 자체는 유효하므로 주소 새로고침 실패는 무시 */ }
        if (!isCurrent()) { client.close(); return false; }
        const refreshedOrigins = [...new Set([candidate.origin, ...connectionOrigins(pc), ...refreshedHosts.map((host) => parsePcAddress(host, refreshedPort, 'http').origin)])];
        const connectedPc = { ...pc, hosts: refreshedHosts, origins: refreshedOrigins, activeHost: candidate.host, activeOrigin: candidate.origin };
        const currentPcs = await loadPcs();
        if (!isCurrent() || !currentPcs.some((item) => item.id === pc.id)) { client.close(); return false; }
        const saved = currentPcs.map((item) => item.id === pc.id ? connectedPc : item);
        await savePcs(saved);
        if (!isCurrent()) { client.close(); return false; }
        await setLastPcId(pc.id);
        if (!isCurrent()) { client.close(); return false; }
        setConnectingId(null);
        onConnected(connectedPc);
        return true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (isCurrent()) {
      setError(`${pc.name} 연결 실패: ${lastError}\nPC 주소와 네트워크 연결 상태를 확인하세요.`);
      setConnectingId(null);
    }
    return false;
  };

  const addPc = async (): Promise<void> => {
    if (busy || !hostPort.trim() || !PAIRING_PIN_PATTERN.test(pin)) return;
    setBusy(true);
    setError('');
    try {
      const parsed = parsePcAddress(hostPort);
      const secret = await exchangePin(parsed.origin, pin, name.trim() || '모바일');
      const pc: Omit<SavedPc, 'id' | 'addedAt'> = {
        name: name.trim() || hostPort.trim(),
        host: parsed.host,
        port: parsed.port,
        protocol: parsed.protocol,
        origins: [parsed.origin],
        activeOrigin: parsed.origin,
        secret,
      };
      const next = await upsertPc(await loadPcs(), pc);
      await savePcs(next);
      setPcs(next);
      setShowAdd(false);
      setName('');
      setHostPort('');
      setPin('');
      const savedPc = next.find((item) => connectionOrigins(item).includes(parsed.origin));
      if (!savedPc) throw new Error('저장된 PC를 찾지 못했습니다.');
      await connect(savedPc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onScan = (data: string): void => {
    if (scanLockRef.current) return;
    const payload = parsePairingPayload(data);
    if (!payload) {
      setScanError('다른 QR입니다. 카메라는 계속 스캔 중이니 Mr.Robot 연결 QR을 비춰주세요.');
      if (invalidHintTimerRef.current) clearTimeout(invalidHintTimerRef.current);
      const session = scannerSessionRef.current;
      invalidHintTimerRef.current = setTimeout(() => {
        if (session === scannerSessionRef.current && !scanLockRef.current) setScanError('');
      }, INVALID_QR_HINT_MS);
      return;
    }
    scanLockRef.current = true;
    setScanHandled(true);
    setDetectedPayload(payload);
    setScanError('');
    setError('');
    void AccessibilityInfo.announceForAccessibility('Mr.Robot 연결 QR을 인식했습니다. 내용을 확인한 뒤 연결 버튼을 누르세요.');
  };

  const connectDetectedPc = async (): Promise<void> => {
    const payload = detectedPayload;
    if (!payload || scanConnectingRef.current) return;
    scanConnectingRef.current = true;
    setScanConnecting(true);
    setScanError('PC 연결 정보를 확인하는 중…');
    const session = scannerSessionRef.current;
    try {
      const primary = parsePcAddress(payload.host, payload.port, payload.protocol ?? 'http');
      const origins = pairingOrigins(payload);
      const hosts = [...new Set(origins.map((origin) => parsePcAddress(origin).host))];
      const paired = await exchangePinAcrossOrigins(origins, payload.pin, `모바일 (${payload.host})`);
      const secret = paired.secret;
      const next = await upsertPc(await loadPcs(), {
        name: `PC (${payload.host})`,
        host: primary.host,
        hosts,
        activeHost: parsePcAddress(paired.origin).host,
        protocol: primary.protocol,
        origins,
        activeOrigin: paired.origin,
        port: primary.port,
        secret,
      });
      await savePcs(next);
      setPcs(next);
      const savedPc = next.find((item) => connectionOrigins(item).some((origin) => origins.includes(origin)));
      if (!savedPc) throw new Error('저장된 PC를 찾지 못했습니다.');
      const connected = await connect(savedPc);
      if (connected) {
        if (session === scannerSessionRef.current) setShowScan(false);
      } else if (session === scannerSessionRef.current) {
        setScanError('주소는 저장했지만 지금 연결되지 않습니다. PC 주소와 네트워크 상태를 확인하세요.');
      }
    } catch (err) {
      if (session === scannerSessionRef.current) setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      scanConnectingRef.current = false;
      if (session === scannerSessionRef.current) setScanConnecting(false);
    }
  };

  const resetScanner = (): void => {
    if (scanConnectingRef.current) return;
    scannerSessionRef.current += 1;
    scanLockRef.current = false;
    if (invalidHintTimerRef.current) clearTimeout(invalidHintTimerRef.current);
    invalidHintTimerRef.current = null;
    setDetectedPayload(null);
    setScanHandled(false);
    setScanReady(false);
    setScanError('');
    setScannerKey((value) => value + 1);
  };

  const closeScanner = (): void => {
    if (scanConnectingRef.current) return;
    scannerSessionRef.current += 1;
    scanLockRef.current = false;
    if (invalidHintTimerRef.current) clearTimeout(invalidHintTimerRef.current);
    invalidHintTimerRef.current = null;
    setDetectedPayload(null);
    setScanHandled(false);
    setScanReady(false);
    setScanError('');
    setShowScan(false);
  };

  const deletePc = async (id: string): Promise<void> => {
    deletedIds.current.add(id);
    connectGeneration.current += 1;
    if (connectingId === id) {
      client.close();
      setConnectingId(null);
    }
    const next = await removePc(await loadPcs(), id);
    await savePcs(next);
    if (await getLastPcId() === id) await setLastPcId(null);
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
    scannerSessionRef.current += 1;
    scanLockRef.current = false;
    setScanHandled(false);
    setScanReady(false);
    setScanError('');
    setDetectedPayload(null);
    setScanConnecting(false);
    setShowScan(true);
  };

  const detectedOrigins = detectedPayload ? pairingOrigins(detectedPayload) : [];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 18, 38) }]}>
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
                  {connectionOrigins(pc)[0] ?? '보안 접속 주소 없음 · 다시 등록 필요'}
                </Text>
                <Text style={styles.pcRoute}>{pc.secret ? `저장된 접속 주소 ${connectionOrigins(pc).length.toLocaleString()}개` : '자격증명 복구/재등록 필요'}</Text>
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
              <TouchableOpacity style={[styles.deleteBtn, connectingId !== null && styles.btnDisabled]} onPress={() => void deletePc(pc.id)} disabled={connectingId !== null}>
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
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={[styles.modalBackdrop, { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) }]}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
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
            <Text style={styles.addressHelp}>PC 플러그인의 Quick Link HTTPS 주소를 입력하세요. Tailscale을 쓰는 경우에만 100.64/10 주소를 사용할 수 있습니다. 일반 HTTP LAN 주소는 차단됩니다.</Text>
            <TextInput
              style={styles.input}
              value={hostPort}
              onChangeText={setHostPort}
              placeholder="https://…trycloudflare.com"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>연결 코드</Text>
            <Text style={styles.addressHelp}>PC 화면의 6자리 PIN 또는 외출용으로 발급한 12자리 일회용 코드를 입력하세요.</Text>
            <TextInput
              style={[styles.input, styles.pinInput, pin.length > 6 && styles.pinInputLong]}
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 12))}
              placeholder="6자리 또는 12자리"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              maxLength={12}
              accessibilityLabel="PC 연결 코드"
              accessibilityHint="6자리 PIN 또는 12자리 외출용 일회용 코드를 입력합니다."
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.bigBtn, { flex: 1 }]} onPress={() => setShowAdd(false)}>
                <Text style={styles.bigBtnText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bigBtn, styles.bigBtnAlt, { flex: 1 }, busy && styles.btnDisabled]}
                onPress={() => void addPc()}
                disabled={busy || !hostPort.trim() || !PAIRING_PIN_PATTERN.test(pin)}
                accessibilityRole="button"
                accessibilityLabel={busy ? 'PC 등록 중' : 'PC 등록 및 연결'}
              >
                <Text style={styles.bigBtnText}>{busy ? '등록 중…' : '등록 및 연결'}</Text>
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showScan} animationType="slide" onRequestClose={closeScanner}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {showScan && <CameraView
            key={scannerKey}
            style={{ flex: 1 }}
            facing="back"
            mode="picture"
            onCameraReady={() => setScanReady(true)}
            onMountError={(event) => {
              scanLockRef.current = true;
              setScanReady(false);
              setScanHandled(true);
              setScanError(`카메라를 열지 못했습니다: ${event.message}`);
            }}
            onBarcodeScanned={scanReady && !scanHandled ? (res) => onScan(res.data) : undefined}
            barcodeScannerSettings={QR_SCANNER_SETTINGS}
          />}
          <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            style={[styles.scanReticle, detectedPayload && styles.scanReticleDetected]}
          >
            <Text style={styles.scanReticleMark}>{detectedPayload ? '✓' : ''}</Text>
          </View>
          <View style={[styles.scanBar, { paddingBottom: Math.max(20, insets.bottom) }]}>
            {!scanReady && !detectedPayload ? <ActivityIndicator color={colors.accent2} accessibilityLabel="카메라 준비 중" /> : null}
            <Text style={styles.scanHint} accessibilityLiveRegion="polite">
              {scanError || (detectedPayload ? 'Mr.Robot QR 인식 완료 · 아래 내용을 확인하세요.' : '테두리 안에 PC의 Mr.Robot 연결 QR을 맞춰주세요. 다른 QR은 무시하고 계속 스캔합니다.')}
            </Text>
            {detectedPayload && <View
              style={styles.detectedCard}
              accessible
              accessibilityLabel={`Mr.Robot QR 인식됨. 연결 후보 주소 ${detectedOrigins.join(', ')}. ${detectedPayload.pin.length}자리 일회용 연결 코드.`}
            >
              <Text style={styles.detectedTitle}>✓ Mr.Robot QR 인식됨</Text>
              {detectedOrigins.map((origin, index) => <Text style={styles.detectedAddress} numberOfLines={2} key={origin}>
                {detectedOrigins.length > 1 ? `후보 ${index + 1} · ${origin}` : origin}
              </Text>)}
              <Text style={styles.detectedMeta}>{detectedPayload.pin.length === 12 ? '외출용 12자리 일회용 코드' : '6자리 일회용 PIN'} · 표시된 후보만 순서대로 확인하며 아직 연결하지 않았습니다.</Text>
            </View>}
            {detectedPayload ? <View style={styles.scanActions}>
              <TouchableOpacity
                style={[styles.bigBtn, styles.bigBtnAlt, styles.scanAction, scanConnecting && styles.btnDisabled]}
                onPress={() => void connectDetectedPc()}
                disabled={scanConnecting}
                accessibilityRole="button"
                accessibilityLabel={scanConnecting ? 'PC에 연결 중' : '인식한 PC에 연결'}
              >
                {scanConnecting ? <ActivityIndicator color="#fff" /> : <Text style={styles.bigBtnText}>이 PC에 연결</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bigBtn, styles.scanAction, scanConnecting && styles.btnDisabled]}
                onPress={resetScanner}
                disabled={scanConnecting}
                accessibilityRole="button"
                accessibilityLabel="다시 스캔"
              >
                <Text style={styles.bigBtnText}>다시 스캔</Text>
              </TouchableOpacity>
            </View> : null}
            {scanHandled && !detectedPayload && scanError ? <TouchableOpacity
              style={[styles.bigBtn, styles.bigBtnAlt]}
              onPress={resetScanner}
              accessibilityRole="button"
              accessibilityLabel="카메라 다시 열기"
            ><Text style={styles.bigBtnText}>카메라 다시 열기</Text></TouchableOpacity> : null}
            <TouchableOpacity
              style={[styles.bigBtn, scanConnecting && styles.btnDisabled]}
              onPress={closeScanner}
              disabled={scanConnecting}
              accessibilityRole="button"
              accessibilityLabel="QR 스캐너 닫기"
            >
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
  header: { paddingHorizontal: 24, paddingBottom: 16 },
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
  modalScroll: { width: '100%' },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center' },
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
  pinInputLong: { letterSpacing: 3, fontSize: 17 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  scanReticle: {
    position: 'absolute',
    top: '20%',
    alignSelf: 'center',
    width: 250,
    height: 250,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.82)',
    borderRadius: 24,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanReticleDetected: {
    borderColor: colors.accent2,
    backgroundColor: 'rgba(34,211,238,0.08)',
  },
  scanReticleMark: { color: colors.accent2, fontSize: 58, fontWeight: '800' },
  scanBar: {
    padding: 20,
    backgroundColor: '#0b0f1a',
    gap: 14,
    alignItems: 'center',
  },
  scanHint: { color: colors.dim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  detectedCard: {
    alignSelf: 'stretch',
    gap: 6,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.42)',
    borderRadius: radius.md,
    backgroundColor: 'rgba(34,211,238,0.09)',
  },
  detectedTitle: { color: colors.accent2, fontSize: 15, fontWeight: '800' },
  detectedAddress: { color: colors.text, fontSize: 13, lineHeight: 18 },
  detectedMeta: { color: colors.faint, fontSize: 12, lineHeight: 17 },
  scanActions: { alignSelf: 'stretch', flexDirection: 'row', gap: 10 },
  scanAction: { flex: 1, paddingHorizontal: 10 },
});
