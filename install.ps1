#Requires -Version 5.1
<#
  finsec-persona — 네이티브 메시징 호스트 등록 + 인증서 생성 (Windows 판 install.sh).

  사용법:
    .\install.ps1 <확장 ID>              설치
    .\install.ps1 <확장 ID> -TrustCert   설치 + 인증서를 현재 사용자 신뢰 저장소에 등록
    .\install.ps1 <확장 ID> -Force       인증서를 지우고 다시 생성
    .\install.ps1 -Uninstall             레지스트리 등록 + 생성 파일 제거

  확장 ID 는 chrome://extensions 에서 "압축해제된 확장 프로그램을 로드" 후 표시되는 값.

  macOS/Linux 판(install.sh)과의 차이:
    - 매니페스트를 파일 경로가 아니라 레지스트리(HKCU\...\NativeMessagingHosts)에 등록한다.
    - 크롬은 Windows 에서 .exe 또는 .bat 만 네이티브 호스트로 실행하므로 wrapper 가 run-host.bat.
    - openssl 이 없으면 New-SelfSignedCertificate 로 만들고 PEM 으로 직접 내보낸다.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$ExtensionId,

  # 인증서를 현재 사용자의 "신뢰할 수 있는 루트 인증 기관" 저장소에 바로 등록한다.
  # (Windows 가 보안 경고 창을 띄우므로 [예] 를 눌러야 한다)
  [switch]$TrustCert,

  # 기존 인증서를 버리고 새로 만든다.
  [switch]$Force,

  # 레지스트리 등록과 install 이 만든 파일을 제거한다.
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$HOST_NAME  = 'com.finsec.host'
$Root       = $PSScriptRoot
$HostDir    = Join-Path $Root 'host'
$CertDir    = Join-Path $HostDir 'certs'
$CertFile   = Join-Path $CertDir 'finsec-persona.crt'
$KeyFile    = Join-Path $CertDir 'finsec-persona.key'
$Wrapper    = Join-Path $HostDir 'run-host.bat'
$ManifestFile = Join-Path $HostDir "$HOST_NAME.json"
$NativeHostJs = Join-Path $HostDir 'native-host.js'

# 크로미움 계열 브라우저의 HKCU 레지스트리 경로. 앞이 브라우저 감지용 키, 뒤가 등록 대상.
$Browsers = @(
  @{ Name = 'Chrome';        Base = 'HKCU:\Software\Google\Chrome' }
  @{ Name = 'Chrome Beta';   Base = 'HKCU:\Software\Google\Chrome Beta' }
  @{ Name = 'Chrome Dev';    Base = 'HKCU:\Software\Google\Chrome Dev' }
  @{ Name = 'Chrome Canary'; Base = 'HKCU:\Software\Google\Chrome SxS' }
  @{ Name = 'Edge';          Base = 'HKCU:\Software\Microsoft\Edge' }
  @{ Name = 'Chromium';      Base = 'HKCU:\Software\Chromium' }
  @{ Name = 'Brave';         Base = 'HKCU:\Software\BraveSoftware\Brave-Browser' }
  @{ Name = 'Vivaldi';       Base = 'HKCU:\Software\Vivaldi' }
  @{ Name = 'Opera';         Base = 'HKCU:\Software\Opera Software' }
  @{ Name = 'Naver Whale';   Base = 'HKCU:\Software\Naver\Whale' }
)
# 아무 브라우저도 감지되지 않았을 때 그래도 등록해 둘 대상.
$FallbackBrowsers = @('Chrome', 'Edge')

function Write-Ok   ($m) { Write-Host "[OK] $m"   -ForegroundColor Green }
function Write-Skip ($m) { Write-Host "[--] $m"   -ForegroundColor DarkGray }
function Write-Warn2($m) { Write-Host "[!!] $m"   -ForegroundColor Yellow }
function Write-Step ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

function Write-TextFileUtf8 {
  # BOM 없는 UTF-8. (크롬의 매니페스트 파서, cmd.exe 둘 다 BOM 을 싫어한다)
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- 제거
if ($Uninstall) {
  Write-Step '네이티브 메시징 등록 제거'
  $removed = 0
  foreach ($b in $Browsers) {
    $key = "$($b.Base)\NativeMessagingHosts\$HOST_NAME"
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Ok "레지스트리 삭제: $key"
      $removed++
    }
  }
  if ($removed -eq 0) { Write-Skip '등록된 레지스트리 키 없음' }

  foreach ($f in @($ManifestFile, $Wrapper)) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Ok "삭제: $f" }
  }
  Write-Host ''
  Write-Host "인증서는 남겨 두었다. 함께 지우려면:" -ForegroundColor DarkGray
  Write-Host "  Remove-Item -Recurse -Force `"$CertDir`"" -ForegroundColor DarkGray
  Write-Host "  Get-ChildItem Cert:\CurrentUser\Root | Where-Object { `$_.Subject -like '*finsec-persona*' } | Remove-Item" -ForegroundColor DarkGray
  exit 0
}

# ---------------------------------------------------------------- 인자 확인
if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  Write-Host '사용법: .\install.ps1 <확장 ID>' -ForegroundColor Yellow
  Write-Host "  1) chrome://extensions → 개발자 모드 ON → '압축해제된 확장 프로그램을 로드' → extension\ 폴더 선택"
  Write-Host '  2) 표시된 확장 ID 를 복사해 인자로 전달'
  Write-Host ''
  Write-Host '  옵션: -TrustCert (인증서 신뢰 등록까지)  -Force (인증서 재생성)  -Uninstall (제거)'
  exit 1
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Warn2 "확장 ID 형식이 이상하다: '$ExtensionId' (보통 a~p 32글자). 그대로 진행한다."
}
if (-not (Test-Path $NativeHostJs)) {
  Write-Host "오류: $NativeHostJs 가 없다. 이 스크립트는 저장소 루트에 있어야 한다." -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 1) node 찾기
Write-Step '1) node 확인'
$NodeExe = $null
# Select-Object -First 1 로 받는다. Where-Object 결과가 1건이면 배열이 아니라 문자열이라
# [0] 으로 꺼내면 경로가 아니라 첫 글자('C')가 나온다.
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cmd) { $NodeExe = $cmd.Source }
if (-not $NodeExe) {
  # PATH 에 없는 경우: cmd 창이 node 설치 전부터 열려 있으면 PATH 가 갱신되지 않는다.
  $NodeExe = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' })
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK 'node.exe' })
    $(if ($env:FNM_DIR) { Join-Path $env:FNM_DIR 'aliases\default\node.exe' })
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $NodeExe) {
  Write-Host '오류: node 를 찾지 못했다. https://nodejs.org 에서 설치 후 다시 실행.' -ForegroundColor Red
  exit 1
}
$NodeExe = (Resolve-Path $NodeExe).Path
$nodeVer = (& $NodeExe --version) 2>$null
Write-Ok "node: $NodeExe ($nodeVer)"

# ---------------------------------------------------------------- 2) 인증서
Write-Step '2) self-signed 인증서'

# SAN: 페이지가 https://127.0.0.1:<port> 와 https://lx.astxsvc.com:55920 둘 다로 접속한다.
$SanDns = @('localhost', 'lx.astxsvc.com', '*.astxsvc.com')
$SanIp  = '127.0.0.1'
$CertSubject = 'CN=finsec-persona localhost'
$CertDays = 825   # macOS 의 TLS 서버 인증서 유효기간 상한에 맞춰 둔 값

function Find-OpenSsl {
  $c = Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return @(
    (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe')
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Git\usr\bin\openssl.exe' })
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\openssl.exe')
    (Join-Path $env:ProgramFiles 'OpenSSL-Win64\bin\openssl.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# --- DER/PEM 인코딩 (openssl 이 없을 때 개인키를 PKCS#1 PEM 으로 직접 써야 한다) ---
function ConvertTo-DerLength {
  param([int]$Length)
  $out = New-Object System.Collections.Generic.List[byte]
  if ($Length -lt 0x80) {
    $out.Add([byte]$Length)
  } else {
    $tmp = New-Object System.Collections.Generic.List[byte]
    $n = $Length
    while ($n -gt 0) { $tmp.Insert(0, [byte]($n -band 0xFF)); $n = $n -shr 8 }
    $out.Add([byte](0x80 -bor $tmp.Count))
    $out.AddRange($tmp)
  }
  return , $out.ToArray()
}

function ConvertTo-DerInteger {
  # ASN.1 INTEGER: 선행 0 제거 + 최상위 비트가 서면 0x00 을 붙여 양수로 유지.
  param([byte[]]$Value)
  $body = New-Object System.Collections.Generic.List[byte]
  if (-not $Value -or $Value.Length -eq 0) {
    $body.Add([byte]0)
  } else {
    $i = 0
    while ($i -lt ($Value.Length - 1) -and $Value[$i] -eq 0) { $i++ }
    if (($Value[$i] -band 0x80) -ne 0) { $body.Add([byte]0) }
    for ($j = $i; $j -lt $Value.Length; $j++) { $body.Add($Value[$j]) }
  }
  $out = New-Object System.Collections.Generic.List[byte]
  $out.Add([byte]0x02)
  $out.AddRange([byte[]](ConvertTo-DerLength $body.Count))
  $out.AddRange($body)
  return , $out.ToArray()
}

function ConvertTo-DerSequence {
  param([byte[]]$Content)
  $out = New-Object System.Collections.Generic.List[byte]
  $out.Add([byte]0x30)
  $out.AddRange([byte[]](ConvertTo-DerLength $Content.Length))
  $out.AddRange($Content)
  return , $out.ToArray()
}

function ConvertTo-Pem {
  param([byte[]]$Der, [string]$Label)
  $b64 = [Convert]::ToBase64String($Der)
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("-----BEGIN $Label-----`n")
  for ($i = 0; $i -lt $b64.Length; $i += 64) {
    $len = [Math]::Min(64, $b64.Length - $i)
    [void]$sb.Append($b64.Substring($i, $len)).Append("`n")
  }
  [void]$sb.Append("-----END $Label-----`n")
  return $sb.ToString()
}

function ConvertTo-Pkcs1Pem {
  # RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, dp, dq, qInv }  — node 가 그대로 읽는다.
  param([System.Security.Cryptography.RSAParameters]$P)
  $body = New-Object System.Collections.Generic.List[byte]
  $body.AddRange([byte[]](ConvertTo-DerInteger ([byte[]]@(0))))
  foreach ($part in @($P.Modulus, $P.Exponent, $P.D, $P.P, $P.Q, $P.DP, $P.DQ, $P.InverseQ)) {
    $body.AddRange([byte[]](ConvertTo-DerInteger $part))
  }
  $der = [byte[]](ConvertTo-DerSequence ([byte[]]$body.ToArray()))
  return ConvertTo-Pem -Der $der -Label 'RSA PRIVATE KEY'
}

function New-CertWithOpenSsl {
  param([string]$OpenSsl)
  $san = "IP:$SanIp," + (($SanDns | ForEach-Object { "DNS:$_" }) -join ',')
  # CA:FALSE — 신뢰 저장소에 등록되므로 CA 권한이 있으면 키 유출 시 임의 도메인 위조 가능.
  $osslArgs = @(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', $KeyFile, '-out', $CertFile, '-days', "$CertDays",
    '-subj', '/CN=finsec-persona localhost',
    '-addext', "subjectAltName=$san",
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth'
  )
  & $OpenSsl @osslArgs 2>$null
  if ($LASTEXITCODE -ne 0) { throw "openssl 실패 (exit $LASTEXITCODE)" }
}

function New-CertWithWindows {
  # openssl 이 없을 때: Windows 가 키/인증서를 만들고, 우리가 PEM 으로 꺼낸다.
  # 레거시 CSP 를 지정해야 PS 5.1(.NET Framework)에서 개인키 파라미터를 꺼낼 수 있다.
  $sanText = (($SanDns | ForEach-Object { "DNS=$_" }) -join '&') + "&IPAddress=$SanIp"
  $cert = New-SelfSignedCertificate `
    -Subject $CertSubject `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -NotAfter (Get-Date).AddDays($CertDays) `
    -TextExtension @(
      "2.5.29.17={text}$sanText",
      '2.5.29.19={critical}{text}CA=false',
      '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
    )
  try {
    $der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    Write-TextFileUtf8 -Path $CertFile -Text (ConvertTo-Pem -Der $der -Label 'CERTIFICATE')

    $rsa = $cert.PrivateKey
    if (-not $rsa) {
      $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    }
    if (-not $rsa) { throw '개인키를 읽지 못했다' }
    $params = $rsa.ExportParameters($true)
    Write-TextFileUtf8 -Path $KeyFile -Text (ConvertTo-Pkcs1Pem -P $params)
  } finally {
    # 개인 저장소에 남길 이유가 없다 — PEM 으로 꺼냈으니 지운다.
    try { Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue } catch { }
  }
}

if ($Force -and (Test-Path $CertDir)) {
  Remove-Item $CertFile, $KeyFile -Force -ErrorAction SilentlyContinue
  Write-Skip '기존 인증서 삭제 (-Force)'
}

if ((Test-Path $CertFile) -and (Test-Path $KeyFile)) {
  Write-Skip "인증서 이미 있음: $CertFile"
} else {
  New-Item -ItemType Directory -Path $CertDir -Force | Out-Null
  $openssl = Find-OpenSsl
  if ($openssl) {
    New-CertWithOpenSsl -OpenSsl $openssl
    Write-Ok "인증서 생성(openssl): $CertFile"
  } else {
    New-CertWithWindows
    Write-Ok "인증서 생성(New-SelfSignedCertificate): $CertFile"
  }
}

# ---------------------------------------------------------------- 3) wrapper
Write-Step '3) 네이티브 호스트 wrapper'
# 크롬은 네이티브 호스트를 최소 환경으로 실행한다 → node 절대경로를 박아 둔다.
# Windows 에서 크롬이 실행할 수 있는 건 .exe 또는 .bat 뿐이라 .bat 로 만든다.
$batch = "@echo off`r`n`"$NodeExe`" `"$NativeHostJs`" %*`r`n"
Write-TextFileUtf8 -Path $Wrapper -Text $batch
Write-Ok "wrapper: $Wrapper"

# ---------------------------------------------------------------- 4) 매니페스트 + 레지스트리
Write-Step '4) 네이티브 메시징 등록'
$escWrapper = $Wrapper.Replace('\', '\\')
$manifestJson = @"
{
  "name": "$HOST_NAME",
  "description": "finsec-persona native host",
  "path": "$escWrapper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ExtensionId/"]
}
"@
Write-TextFileUtf8 -Path $ManifestFile -Text $manifestJson
Write-Ok "매니페스트: $ManifestFile"

$targets = @($Browsers | Where-Object { Test-Path $_.Base })
if ($targets.Count -eq 0) {
  Write-Warn2 '크로미움 계열 브라우저를 감지하지 못했다 — Chrome/Edge 에 그대로 등록한다.'
  $targets = @($Browsers | Where-Object { $FallbackBrowsers -contains $_.Name })
}
foreach ($b in $targets) {
  $key = "$($b.Base)\NativeMessagingHosts\$HOST_NAME"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-Item -Path $key -Value $ManifestFile     # 레지스트리 기본값 = 매니페스트 파일 경로
  Write-Ok "등록: $($b.Name)  ($key)"
}

# ---------------------------------------------------------------- 5) 인증서 신뢰
Write-Step '5) 인증서 신뢰'
if ($TrustCert) {
  # 크롬/엣지는 Windows 인증서 저장소를 쓴다. CurrentUser\Root 면 관리자 권한이 필요 없다.
  Write-Host '  Windows 보안 경고 창이 뜨면 [예] 를 눌러야 등록된다.' -ForegroundColor DarkGray
  Import-Certificate -FilePath $CertFile -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
  Write-Ok '신뢰할 수 있는 루트 인증 기관(현재 사용자)에 등록'
} else {
  Write-Skip '건너뜀 (-TrustCert 를 주면 자동 등록)'
}

# ---------------------------------------------------------------- 안내
Write-Host ''
Write-Host '다음:' -ForegroundColor Cyan
$n = 1
if (-not $TrustCert) {
  Write-Host "  $n) 인증서 신뢰 등록 (1회, 관리자 권한 불필요 / 보안 경고에 [예]):"
  Write-Host "     Import-Certificate -FilePath `"$CertFile`" -CertStoreLocation Cert:\CurrentUser\Root" -ForegroundColor White
  $n++
}
Write-Host "  $n) 브라우저 완전 종료 후 재시작"
Write-Host '     (크롬은 닫아도 백그라운드에 남을 수 있다 — 작업 표시줄 트레이 아이콘 또는'
Write-Host '      작업 관리자에서 chrome.exe 를 모두 종료한 뒤 다시 켠다)'
$n++
Write-Host "  $n) 확장 팝업에서 [시작]"
$n++
Write-Host "  $n) 사이트별 'Windows 위장' 토글은 필요할 때만 (ASTX 사이트는 끄기)"
Write-Host ''
Write-Host '참고: 확장을 다시 로드해 확장 ID 가 바뀌면 이 스크립트를 다시 실행해야 한다.' -ForegroundColor DarkGray
Write-Host '      서버는 127.0.0.1 에만 바인딩하므로 방화벽 허용 창은 뜨지 않는다.' -ForegroundColor DarkGray

exit 0
