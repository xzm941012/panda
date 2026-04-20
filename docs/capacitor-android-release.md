# Panda Capacitor Android 发布说明

## 目标

- 网页端继续由 Hub 托管 `apps/web` 的标准构建产物
- Android 端通过 Capacitor 壳内置同一套前端资源
- Hub / Agent 继续运行在电脑或局域网机器上
- Android 首启时要求填写并保存 `Hub URL`
- 后续支持 APK 覆盖安装升级，不需要卸载重装

## 本地环境

最小环境：

- Node.js `20.19.x`
- pnpm / corepack
- JDK 21
- Android SDK
- Android SDK Platform 36
- Android SDK Build-Tools 34 或更高
- Android Platform-Tools

推荐目录：

- `JAVA_HOME=C:\Program Files\Java\jdk-21`
- `ANDROID_HOME=D:\ai\android\sdk`
- `ANDROID_SDK_ROOT=D:\ai\android\sdk`

## 关键脚本

- `pnpm build:web`
  - 构建 Hub 托管的网页端
- `pnpm build:mobile:web`
  - 构建 Android 壳内置的本地前端资源
- `pnpm android:sync`
  - 构建移动端前端并同步到 Capacitor Android 工程
- `pnpm android:release`
  - 产出 release APK 到 `release/android/panda-android-release.apk`
- `pnpm release:build`
  - 构建网页端 release 包和 Hub/Agent CLI 包
- `pnpm release:build:android`
  - 构建 release APK，并把 APK 与 `latest.json` 放进 Hub 发布目录
- `pnpm release:build:all`
  - 一次性完成网页端发布产物和 Android 发布产物

## 常用 APK 命令

只同步移动端前端资源到 Android 工程：

```powershell
corepack pnpm android:sync
```

构建调试 APK：

```powershell
corepack pnpm android:debug
```

构建正式 APK：

```powershell
corepack pnpm android:release
```

构建网页端 + Hub 发布包：

```powershell
corepack pnpm release:build
```

构建 Android 发布包并生成更新清单：

```powershell
corepack pnpm release:build:android
```

一次性构建网页端和 Android 全部发布产物：

```powershell
corepack pnpm release:build:all
```

## 首次出包

执行：

```powershell
corepack pnpm install
corepack pnpm release:build:all
```

首次 release 构建时会自动：

- 生成 `apps/mobile/android/keystore.properties`
- 在 `.local/android/signing/panda-upload.jks` 生成本地签名证书
- 把 SDK 路径写入 `apps/mobile/android/local.properties`
- 输出 Android release APK

## 产物位置

本地 APK：

- `release/android/panda-android-release.apk`
- `release/android/latest.json`

Hub 可托管的更新产物：

- `release/panda-hub/dist/downloads/android/panda-android-release.apk`
- `release/panda-hub/dist/downloads/android/latest.json`

## 升级流程

1. 发布新版本时运行 `pnpm release:build:all`
2. 用新的 `release/panda-hub/dist` 更新 Hub 的发布目录
3. Android App 在设置页读取 `/downloads/android/latest.json`
4. 发现新版本后打开 `/downloads/android/panda-android-release.apk`
5. Android 系统执行覆盖安装
6. 因为 `applicationId` 固定且签名固定，旧配置和本地缓存会保留

## 配置与行为

- Android App 首次打开会进入首启连接页
- `Hub URL` 保存在本机，后续启动直接跳过首启页
- 修改 `Hub URL` 后会清理旧查询缓存、旧会话定位和连接解析缓存
- 完成提醒：
  - 网页端继续走浏览器通知 / Web Push
  - Android APK 改走 Capacitor 本地通知

## 注意事项

- 当前 Android Gradle Plugin 会对 `compileSdk 36` 给兼容性提示，但构建可成功完成
- Vite 会提示主包 chunk 偏大；这不阻塞当前 APK 产出，后续如需再做代码分包优化
- 如果你要在另一台机器继续发同一个升级链，请保留：
  - `.local/android/signing/panda-upload.jks`
  - `apps/mobile/android/keystore.properties`
