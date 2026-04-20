param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$signingRoot = Join-Path $ProjectRoot '.local\android\signing'
$keystorePath = Join-Path $signingRoot 'panda-upload.jks'
$propertiesPath = Join-Path $ProjectRoot 'apps\mobile\android\keystore.properties'

$storePassword = if ($env:PANDA_ANDROID_KEYSTORE_PASSWORD) {
  $env:PANDA_ANDROID_KEYSTORE_PASSWORD
} else {
  'panda-android-dev'
}
$keyPassword = if ($env:PANDA_ANDROID_KEY_PASSWORD) {
  $env:PANDA_ANDROID_KEY_PASSWORD
} else {
  $storePassword
}
$keyAlias = if ($env:PANDA_ANDROID_KEY_ALIAS) {
  $env:PANDA_ANDROID_KEY_ALIAS
} else {
  'panda-upload'
}

New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null

$javaHome = if ($env:JAVA_HOME -and $env:JAVA_HOME -match 'jdk-21' -and (Test-Path $env:JAVA_HOME)) {
  $env:JAVA_HOME
} elseif (Test-Path 'C:\Program Files\Java\jdk-21') {
  'C:\Program Files\Java\jdk-21'
} else {
  $env:JAVA_HOME
}
$keytoolPath = if ($javaHome) {
  Join-Path $javaHome 'bin\keytool.exe'
} else {
  'keytool'
}

if (-not (Test-Path $keystorePath)) {
  & $keytoolPath `
    -genkeypair `
    -v `
    -keystore $keystorePath `
    -storetype PKCS12 `
    -storepass $storePassword `
    -keypass $keyPassword `
    -alias $keyAlias `
    -keyalg RSA `
    -keysize 2048 `
    -validity 36500 `
    -dname 'CN=Panda Android, OU=Panda, O=Panda, L=Shanghai, ST=Shanghai, C=CN'
}

$propertiesContent = @"
storeFile=$keystorePath
storePassword=$storePassword
keyAlias=$keyAlias
keyPassword=$keyPassword
"@

Set-Content -LiteralPath $propertiesPath -Value $propertiesContent -Encoding UTF8
