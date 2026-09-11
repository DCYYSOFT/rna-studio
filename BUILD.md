# 构建桌面安装包

把 RNA Studio 打包成 **macOS 应用**和 **Windows 程序**，用户拿到后双击即可运行，
不需要装 Python、也不需要装 Java。

> **为什么不能只构建一次？**
> PyInstaller 这类工具不支持跨平台编译 —— 要出 macOS 应用就必须在 macOS 上跑，
> 要出 Windows 程序就必须在 Windows 上跑。所以这里提供两种途径：
> 让 GitHub 的机器帮你各跑一次（推荐），或者你在自己两台机器上各跑一次。

---

## 方式一：GitHub Actions（推荐）

一次配置，之后两个平台的安装包自动产出，你不需要在本机装任何构建工具。

### 第一次配置

在项目目录下跑一个脚本就行：

```bash
cd rna-studio
./push_to_github.sh
```

脚本会依次完成：检查 git 身份 → 确认 `.gitignore` 挡住了 `.venv`、`jre` 等大文件 →
初始化仓库并提交 → 推送。**它不会把 `.venv`、`jre`、`dist` 这些本地产物推上去**
（实测 58MB 的虚拟环境会被完整排除）。

推送有两条路径，脚本会自动选：

**A. 已装 gh CLI**（全自动，推荐）

```bash
brew install gh
gh auth login
./push_to_github.sh        # 自动建仓库并推送，全程不用打开浏览器
```

**B. 没装 gh**

脚本提交完后会提示你到 https://github.com/new 建一个**空仓库**，
把地址粘回终端即可。注意**不要勾选** Add README / .gitignore / license ——
仓库非空的话推送会被拒绝。

也可以直接指定仓库名或地址：

```bash
./push_to_github.sh rna-studio
./push_to_github.sh https://github.com/你的用户名/rna-studio.git
```

### 拿到安装包

推送完成后（或之后任何一次推送到 main），打开仓库的 **Actions** 页面，
能看到「构建安装包」这个 workflow 在跑，大约 5–10 分钟后两个 job 都会变绿。

点进任意一次成功的运行，页面底部 **Artifacts** 区域有：

| 名称 | 内容 |
|---|---|
| `RNA-Studio-macOS-arm64` | `.dmg`，Apple Silicon 用 |
| `RNA-Studio-Windows-x64` | `.zip`，内含 `RNA Studio.exe` |

点一下就能下载。

### 发布正式版本

想让它自动挂到 Releases 上（方便直接分享链接），打个 tag 推上去：

```bash
git tag v0.0.4
git push origin v0.0.4
```

构建完成后会自动创建同名 Release，并把两个安装包作为附件挂上去。

### 想重新构建

Actions 页面左侧选「构建安装包」，右上角 **Run workflow** 手动触发即可。

### 构建过程都做了什么

每个平台的 job 依次执行：

1. 装 Python 3.12
2. 装 JDK 21（提供 `jlink`）
3. 用 `jlink` 生成**精简 JRE**（`java.base` + `java.desktop`，约 58 MB）
   —— VARNA 是 Swing 程序，渲染需要 `java.desktop`；只用 `java.base` 会报
   `NoClassDefFoundError: java/awt/Graphics`
4. 装 Python 依赖（ViennaRNA 在两个平台都有预编译 wheel，不需要编译）
5. 跑 PyInstaller，产出 `.app` / `.exe`
6. **冒烟测试**：真的启动打包好的程序，等它把服务地址写进文件，
   再请求 `/api/status` 确认后端活着、引擎可用 —— 不通过就判定构建失败
7. 打 `.dmg` / `.zip` 并上传

---

## 方式二：在本机构建

如果你不想用 GitHub，也可以在两台机器上各跑一次构建脚本。

### macOS（Apple Silicon）

需要：Python 3.9+、JDK 17+（提供 `jlink`）

```bash
brew install openjdk@21          # 提供 jlink；已有 JDK 可跳过

cd rna-studio
./packaging/build_macos.sh
```

产物：`dist/RNA Studio.app` 和 `release/RNA-Studio-0.0.4-macOS-arm64.dmg`

脚本会自己建虚拟环境、装依赖、生成精简 JRE、打包、ad-hoc 签名、做 DMG。
没装 JDK 也能跑完，只是不带 JRE（VARNA 出图会去找系统 Java）。

### Windows（64 位）

需要：Python 3.9+、JDK 17+（提供 `jlink.exe`）

```powershell
winget install EclipseAdoptium.Temurin.21.JDK   # 已有 JDK 可跳过

cd rna-studio
powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1
```

产物：`dist\RNA Studio\RNA Studio.exe` 和 `release\RNA-Studio-0.0.4-Windows-x64.zip`

---

## 用户拿到安装包后

### macOS

打开 `.dmg`，把 RNA Studio 拖进「应用程序」。首次打开会提示
**「无法验证开发者」**——因为应用没有购买苹果开发者证书（一年 99 美元）。
这是正常的，解压出来的 DMG 里附了一份说明。打开方式：

- 右键点击 RNA Studio →「打开」→ 再点一次「打开」（只需一次），或
- 终端执行 `xattr -dr com.apple.quarantine "/Applications/RNA Studio.app"`

如果你有开发者证书，把 `packaging/build_macos.sh` 里的
`codesign --sign -` 换成你的证书 ID，用户就不会看到这个提示了。

### Windows

解压 zip，双击 `RNA Studio.exe`。首次运行可能弹 SmartScreen
**「已保护你的电脑」**，点「更多信息」→「仍要运行」。

---

## 安装包里有什么

打包后约 230 MB（解压状态），构成大致是：

| 部分 | 大小 | 说明 |
|---|---|---|
| 精简 JRE | ~58 MB | VARNA 出图用 |
| Python 运行时 + FastAPI 等 | ~60 MB | |
| ViennaRNA 及其绑定 | ~15 MB | 主预测引擎 |
| 前端与 VARNA jar | ~1 MB | |

**不包含** RNAstructure —— 它是 GPL 程序且官方 macOS 版是 x86_64，
塞进包里意义不大。需要它的话，用户按 README 里的说明单独装即可，
装好后应用会自动识别。

---

## 常见问题

**构建时报 `ModuleNotFoundError: uvicorn...`**
`packaging/rna-studio.spec` 里的 `hiddenimports` 少了模块。uvicorn 和 pywebview
都是运行时动态导入，必须显式列出。补进 spec 的 `hiddenimports` 即可。

**macOS 打包后双击闪退**
看 `~/rna-studio.log`。如果文件不存在，说明进程还没走到写日志就挂了，
多半是某个原生依赖没打进去。可以在终端直接运行
`dist/RNA\ Studio.app/Contents/MacOS/RNA\ Studio` 看报错。

**应用启动了但窗口空白**
窗口里加载的是本机 `127.0.0.1` 上的服务。如果窗口起来了但白屏，
把 `rna-studio.log` 里的地址复制到浏览器打开 —— 能打开说明是窗口后端的问题
（Windows 上常见于没装 WebView2 运行时的老系统）。

**Windows 上 pythonnet / WebView2 报错**
WebView2 运行时在 Win10 1803+ 和 Win11 上是系统自带的。极老的系统需要
单独装一次：https://developer.microsoft.com/microsoft-edge/webview2/

**想减小安装包**
精简单词 JRE 是大头。VARNA 需要 `java.desktop`，砍不掉多少。真正的办法是
不带 JRE，让用户自己装 Java —— 但那样就失去了「双击即用」的意义。
