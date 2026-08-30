param(
  [string]$OutputDirectory = '',
  [switch]$InitializeSigningKey,
  [string]$ExpectedCertificateSha256 = 'EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($repoRoot -match '[^\x00-\x7F]') {
  throw 'Windows React Native NDK 빌드는 현재 ASCII 문자만 포함한 체크아웃 경로가 필요합니다. 저장소를 C:\MrRobot 같은 영문 경로에 체크아웃한 뒤 이 스크립트를 다시 실행하세요.'
}
if ($InitializeSigningKey -and -not $PSBoundParameters.ContainsKey('ExpectedCertificateSha256')) {
  $ExpectedCertificateSha256 = ''
}
$userProfilePath = [Environment]::GetFolderPath('UserProfile')
$signingRoot = Join-Path $userProfilePath '.mr-robot\signing'
$keystorePath = Join-Path $signingRoot 'mr-robot-release.jks'
$protectedPasswordPath = Join-Path $signingRoot 'android-password.dpapi'
$aliasName = 'mrrobot'
$originalAndroidHome = $env:ANDROID_HOME
$originalAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$originalNodeEnv = $env:NODE_ENV

function Restore-EnvironmentVariable([string]$name, [string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  } else {
    Set-Item "Env:$name" $value
  }
}

function Resolve-AndroidSdk {
  $candidates = @(
    $env:ANDROID_SDK_ROOT,
    $env:ANDROID_HOME,
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Android\Sdk'),
    (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Android\Sdk'),
    'C:\Android\Sdk'
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

  foreach ($candidate in $candidates) {
    $resolved = [Environment]::ExpandEnvironmentVariables($candidate)
    if ((Test-Path -LiteralPath $resolved -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $resolved 'platform-tools') -PathType Container)) {
      return (Resolve-Path -LiteralPath $resolved).Path
    }
  }

  throw 'Android SDK를 찾을 수 없습니다. Android Studio에서 SDK와 Platform Tools를 설치하세요.'
}

function ConvertFrom-ProtectedPassword([string]$protectedValue) {
  $secureValue = ConvertTo-SecureString $protectedValue
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
$keytool = Get-Command keytool.exe -ErrorAction SilentlyContinue
if (-not $keytool) { throw 'JDK keytool.exe가 없습니다. Android Studio 또는 JDK 17 이상을 설치하세요.' }
$androidSdk = Resolve-AndroidSdk
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
Write-Output "Android SDK: $androidSdk"

$hasKeystore = Test-Path -LiteralPath $keystorePath -PathType Leaf
$hasProtectedPassword = Test-Path -LiteralPath $protectedPasswordPath -PathType Leaf
if ($hasKeystore -xor $hasProtectedPassword) {
  throw 'Android 서명 자료가 불완전합니다. 기존 keystore와 DPAPI 암호 파일을 복구한 뒤 다시 실행하세요. 새 키로 덮어쓰지 않습니다.'
}

if (-not $hasKeystore) {
  if (-not $InitializeSigningKey) {
    throw 'Android 릴리스 서명키가 없습니다. 기존 공식 키를 복구하세요. 새 프로젝트 서명 ID를 의도적으로 만들 때만 -InitializeSigningKey를 사용하세요.'
  }
  $randomBytes = New-Object byte[] 36
  $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $randomGenerator.GetBytes($randomBytes) }
  finally { $randomGenerator.Dispose() }
  $password = [Convert]::ToBase64String($randomBytes)
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $protectedPassword = ConvertFrom-SecureString $securePassword
  [IO.File]::WriteAllText($protectedPasswordPath, $protectedPassword, [Text.UTF8Encoding]::new($false))

  $env:MR_ROBOT_ANDROID_STORE_PASSWORD = $password
  $env:MR_ROBOT_ANDROID_KEY_PASSWORD = $password
  & $keytool.Source -genkeypair -v -keystore $keystorePath -alias $aliasName -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Mr.Robot, OU=Personal Agent, O=Mr.Robot, L=Seoul, C=KR' -storepass:env MR_ROBOT_ANDROID_STORE_PASSWORD -keypass:env MR_ROBOT_ANDROID_KEY_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw "Android 서명 키 생성 실패: exit $LASTEXITCODE" }
} else {
  $password = ConvertFrom-ProtectedPassword ([IO.File]::ReadAllText($protectedPasswordPath).Trim())
}

$env:MR_ROBOT_ANDROID_KEYSTORE = $keystorePath
$env:MR_ROBOT_ANDROID_STORE_PASSWORD = $password
$env:MR_ROBOT_ANDROID_KEY_ALIAS = $aliasName
$env:MR_ROBOT_ANDROID_KEY_PASSWORD = $password

$appConfigPath = Join-Path $repoRoot 'apps\mobile\app.json'
$appVersion = (Get-Content -LiteralPath $appConfigPath -Raw | ConvertFrom-Json).expo.version
if (-not $appVersion) { throw '모바일 앱 버전을 app.json에서 읽을 수 없습니다.' }
$androidRoot = Join-Path $repoRoot 'apps\mobile\android'
$brandScript = Join-Path $repoRoot 'scripts\generate-brand-assets.mjs'
$noticeScript = Join-Path $repoRoot 'scripts\third-party-notices.mjs'
$noticePath = Join-Path $repoRoot 'THIRD_PARTY_NOTICES.txt'
$generatedAssets = Join-Path $androidRoot 'app\src\generated-assets'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js를 찾을 수 없습니다. Node.js 20.19 이상을 설치하세요.' }

try {
  $env:NODE_ENV = 'production'
  & $node.Source $brandScript
  if ($LASTEXITCODE -ne 0) { throw "브랜드 자산 생성 실패: exit $LASTEXITCODE" }
  & $node.Source $noticeScript
  if ($LASTEXITCODE -ne 0) { throw "서드파티 고지 생성 실패: exit $LASTEXITCODE" }
  New-Item -ItemType Directory -Force -Path $generatedAssets | Out-Null
  Copy-Item -LiteralPath $noticePath -Destination (Join-Path $generatedAssets 'THIRD_PARTY_NOTICES.txt') -Force

  Push-Location $androidRoot
  try {
    & .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "Android release build failed: exit $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:MR_ROBOT_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:MR_ROBOT_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:MR_ROBOT_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
  Remove-Item Env:MR_ROBOT_ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
  Restore-EnvironmentVariable 'ANDROID_HOME' $originalAndroidHome
  Restore-EnvironmentVariable 'ANDROID_SDK_ROOT' $originalAndroidSdkRoot
  Restore-EnvironmentVariable 'NODE_ENV' $originalNodeEnv
}

$apkPath = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path -LiteralPath $apkPath)) { throw '릴리스 APK가 생성되지 않았습니다.' }
$apksigner = Get-ChildItem -Path (Join-Path $androidSdk 'build-tools\*\apksigner.bat') -File |
  Sort-Object { [version]$_.Directory.Name } -Descending |
  Select-Object -First 1
if (-not $apksigner) { throw 'Android SDK Build Tools의 apksigner.bat를 찾을 수 없습니다.' }
$signatureOutput = @(& $apksigner.FullName verify --verbose --print-certs $apkPath 2>&1)
if ($LASTEXITCODE -ne 0) { throw "APK 서명 검증 실패: exit $LASTEXITCODE" }
$certificateLine = $signatureOutput | Where-Object { $_ -match 'certificate SHA-256 digest:\s*([0-9a-fA-F]+)' } | Select-Object -First 1
if (-not $certificateLine) { throw 'APK 서명 인증서 SHA-256을 읽을 수 없습니다.' }
$actualCertificateSha256 = ([regex]::Match([string]$certificateLine, 'certificate SHA-256 digest:\s*([0-9a-fA-F]+)').Groups[1].Value).ToUpperInvariant()
$expectedCertificate = ($ExpectedCertificateSha256 -replace '[^0-9a-fA-F]', '').ToUpperInvariant()
if ($expectedCertificate -and $actualCertificateSha256 -ne $expectedCertificate) {
  throw "APK 서명 인증서가 공식 릴리스 ID와 다릅니다. expected=$expectedCertificate actual=$actualCertificateSha256"
}
Write-Output "APK signature verified: $actualCertificateSha256"
if ($OutputDirectory) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $target = Join-Path $OutputDirectory "Mr.Robot-Mobile-$appVersion.apk"
  Copy-Item -LiteralPath $apkPath -Destination $target -Force
  Write-Output $target
} else {
  Write-Output $apkPath
}
