param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
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

if (-not (Test-Path -LiteralPath $keystorePath) -or -not (Test-Path -LiteralPath $protectedPasswordPath)) {
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

$repoRoot = Split-Path -Parent $PSScriptRoot
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
if ($OutputDirectory) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $target = Join-Path $OutputDirectory "Mr.Robot-Mobile-$appVersion.apk"
  Copy-Item -LiteralPath $apkPath -Destination $target -Force
  Write-Output $target
} else {
  Write-Output $apkPath
}
