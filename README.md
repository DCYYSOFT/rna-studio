# RNA Studio

本地运行的 RNA 二级结构工作台：**从序列预测结构 → 在图上手工改结构 → 立刻看到自由能怎么变**。

预测用 ViennaRNA / RNAstructure，出版级出图用 VARNA，交互编辑用内置渲染器。

---

## 两种用法

### 方式一：安装包（推荐，不用碰命令行）

从 Releases 页面下载对应平台的文件：

| 你的系统 | 下载 | 打开方式 |
|---|---|---|
| macOS（Apple Silicon） | `RNA-Studio-x.x.x-macOS-arm64.dmg` | 拖进「应用程序」，**首次右键→打开** |
| Windows 64 位 | `RNA-Studio-x.x.x-Windows-x64.zip` | 解压后双击 `RNA Studio.exe` |

双击就是一个独立的应用程序窗口，没有终端、没有浏览器地址栏。
安装包**自带 Python、预测引擎和 Java 运行时**，不需要额外装任何东西。

> 两个平台首次打开都会有安全提示（应用未购买代码签名证书），
> 按提示允许一次即可，之后正常双击。详细说明见 `BUILD.md`。

还没有安装包？在项目目录下跑一条命令，让 GitHub 的机器帮你造出来：

```bash
./push_to_github.sh
```

它会初始化仓库、提交并推送，之后 GitHub Actions 自动构建出 macOS 和 Windows
两个平台的安装包。详细说明见 `BUILD.md`。

### 方式二：从源码运行

```bash
cd rna-studio
./run.sh
```

首次运行自动建虚拟环境并装依赖（需联网，约 1–2 分钟），之后秒开。
这条路径会启动本地服务并打开浏览器，适合开发调试。

```bash
./run.sh --port 9000     # 换端口
./run.sh --no-browser    # 不自动开浏览器
python desktop.py        # 以原生窗口方式启动（需先装 requirements-desktop.txt）
```

停止服务：在终端按 `Ctrl+C`。

---

## 环境要求

**用安装包**：什么都不用装，下载即用。

**从源码运行**：

| 组件 | 是否必需 | 说明 |
|---|---|---|
| Python 3.9+ | 必需 | macOS 自带或 `brew install python` |
| ViennaRNA | 必需（自动安装） | 主预测引擎，pip 直接装，两个平台都有预编译包 |
| Java 8+ | 仅 VARNA 出图需要 | 没有也能用内置出图；安装包里已自带精简 JRE |
| RNAstructure | 可选 | 第二个引擎，见下文 |

启动时终端会打印一行环境自检结果，页头右上角的「环境就绪 / 环境告警」也可以点开看详情。

---

## 三种工作模式

**单链折叠** — 粘贴序列 → 点「折叠」得到最小自由能（MFE）结构。

**手动建模** — 序列从全单链开始，自己把配对一个个搭起来。每加/减一对，
上方的 ΔG 读数条立刻更新，并给出与 MFE 的差值（ΔΔG）。适合验证文献里提出的
某个结构模型到底有多不合理，或者试探某个茎区能不能形成。

**共折叠** — 输入两条序列（例如 sRNA 与靶标 mRNA 的一段），预测它们之间的
相互作用结构。链间配对会在图例和提示里单独标出数量。

### 在结构图上怎么操作

| 操作 | 效果 |
|---|---|
| 点一个碱基 | 选中（高亮） |
| 再点另一个碱基 | 建立配对；两端原有的配对会被自动解除 |
| 右键点碱基 | 解除该碱基的配对 |
| Alt+点击 / Shift+点击 | 标记/取消「禁止配对」（图上显示为红色虚线圈） |
| 滚轮 | 以光标为中心缩放 |
| 空白处拖动 | 平移 |
| 双击画布 | 恢复适应窗口 |

按 `Esc` 取消当前选中；`Cmd/Ctrl + Enter` 直接触发折叠。

### 三种布局

- **naview** — 经典的三叶草/茎环画法，最接近文献插图。**不能显示假结**，遇到假结会自动切到环形并给出提示。
- **环形** — 碱基排在圆周上，配对画成圆内弦，类似 VARNA 的 radiate。**可以显示假结**。
- **线性** — 碱基水平排列、配对画成上方弧线。长序列和带假结的结构用这个看最清楚。

---

## 约束与实验数据

这两类输入都会在你点「折叠」时生效（手动编辑画布本身不会改动它们）。

**约束串** 直接写在一行里，长度必须等于序列长度：

- `.` 该位点不限制
- `(` `)` 强制这两个位点配对
- `x` 该位点禁止配对

点「用当前结构作为约束」可以把画布上现在的配对一次性写进约束串，
再折叠就得到「保持这些配对不变、其余部分自由优化」的结果。

**探测数据** 支持 SHAPE 和 DMS。格式是每行「位置 数值」，也可以用单行空格分隔：

```
1 0.042
2 -999        ← 缺测
3 0.150
```

缺测位点也可以直接不写。斜率/截距默认用 Deigan 的标准值 1.8 / −0.6。

> 注意：SHAPE/DMS 是**软约束**（转成伪能量参与折叠），和上面的硬约束是两回事。

---

## 读懂能量读数

上方深色读数条上的四个数：

- **当前 ΔG** — 当前画布上这个结构的自由能。显示「不可行」表示该结构在热力学上不成立
  （比如环太小、空间冲突），此时这个数没有物理意义。
- **MFE ΔG** — 同一条序列在最优化下的自由能，作为参照。
- **与 MFE 差** — 也就是 ΔΔG。**这是手动建模时最该看的数**：0 说明你搭的就是最优结构，
  越大说明越偏离。正数代表不如最优结构稳定。
- **引擎 / 布局** — 当前结果由谁算的、用的哪种画法。

左栏「能量分解」给出逐环的贡献，各项之和严格等于当前 ΔG，可以用来定位
到底是哪个茎或环在贡献稳定性。

> 不同引擎的绝对值会有零点几到几 kcal/mol 的系统差异（参数集不同），
> 这是正常的。要横向比较时请用同一个引擎。

---

## 两个预测引擎

| | ViennaRNA（默认） | RNAstructure |
|---|---|---|
| 安装 | pip 自动 | 需单独装，见下 |
| MFE | ✓ | ✓ |
| 硬约束（强制/禁止配对） | ✓ | 仅 MFE 方法支持 |
| SHAPE / DMS | ✓ | ✓ |
| 配对概率 | ✓ | ✓ |
| 允许假结的结构 | ✗ | ✓ ProbKnot |
| 最大期望准确度 | ✗ | ✓ MaxExpect |
| 共折叠 | ✓ | ✓ |

RNAstructure 的作用是**换一套独立的能量参数交叉验证**，以及提供假结和 MEA 这两类
ViennaRNA 给不了的结果。两者对同一序列的预测通常高度一致但不完全相同。

### 装 RNAstructure（可选）

```bash
./setup_rnastructure.sh
```

脚本会自动下载官方预编译包并解压到 `vendor/RNAstructure`，启动时自动识别。

**Apple Silicon 用户注意**：官方 macOS 版是 x86_64 二进制，需要 Rosetta 2：

```bash
softwareupdate --install-rosetta --agree-to-license
```

如果装在别处，用环境变量指定：

```bash
export RNASTRUCTURE_PATH=/路径/到/RNAstructure   # 目录内应含 exe/ 与 data_tables/
```

---

## 出图与导出

出图有两条路，不用 Java 也完全可用：

**内置出图**（左栏「导出 SVG / 导出 PNG」）把画布上的结构直接导成矢量图，
所见即所得，不依赖任何外部程序。SVG 是矢量格式，可直接插入论文或继续用
Illustrator / Inkscape 编辑；PNG 是 3 倍超采样，适合放进 PPT 或文档。
取景可以选「整幅结构」或「当前画面（含缩放）」。

**VARNA 出图**风格更贴近文献插图，能配出带色标的概率热图。需要 Java
（安装包已随包附带，源码运行则需系统装有 Java）。碱基着色依据可选：

- 按碱基种类（A 绿 / C 蓝 / G 琥珀 / U 红，沿用领域惯例）
- 按配对概率（热图，越深越可靠）
- 按探测反应性（热图，越深越可能处于单链）

**数据导出**支持 CT（可与 mfold / RNAstructure 互操作）、dot-bracket、FASTA。
「导入结构…」可以读入 CT 或 dot-bracket 继续编辑。

---

## 几个容易踩的点

**假结**：ViennaRNA 的近邻热力学模型不支持假结，因此含假结的结构算不出 ΔG，
布局也会自动降级为环形。这是模型的固有限制，不是程序的问题。

**能量单位为 kcal/mol，温度为 °C**（界面上填摄氏度，引擎内部的单位换算已处理）。

**约束串长度必须与序列一致**，否则会在折叠前被拒绝。

**长序列**：超过约 1500 nt 后配对概率矩阵会明显变慢。关掉「配对概率」相关的
着色可以快很多。

---

## 目录结构

```
rna-studio/
├── run.sh                     源码方式启动（浏览器）
├── desktop.py                 桌面方式启动（原生窗口）
├── push_to_github.sh          推送到 GitHub 以触发自动构建
├── setup_rnastructure.sh      安装可选的第二个引擎
├── selftest.py                后端接口自检（python3 selftest.py）
├── requirements.txt           运行依赖
├── requirements-desktop.txt   桌面版额外依赖（pywebview 等）
├── README.md                  本文件
├── BUILD.md                   如何构建 macOS / Windows 安装包
├── packaging/                 打包配置
│   ├── rna-studio.spec        PyInstaller 配置（两个平台共用）
│   ├── build_macos.sh         macOS 一键构建 → .dmg
│   └── build_windows.ps1      Windows 一键构建 → .zip
├── .github/workflows/build.yml  GitHub Actions：自动产出两个平台安装包
├── server/
│   ├── app.py                 FastAPI 路由
│   ├── dotbracket.py          点括号解析与校验（所有引擎输入的安全关口）
│   ├── ct.py                  CT 格式读写
│   ├── layout.py              naview / 环形 / 线性 三种布局
│   ├── varna.py               VARNA 封装
│   ├── paths.py               打包后的资源定位
│   └── engines/
│       ├── vienna.py          ViennaRNA 引擎
│       └── rnastructure.py    RNAstructure 引擎
├── web/                       前端（无构建步骤）
└── vendor/
    └── VARNAv3-93.jar         VARNA（GPL）
```

---

## 出问题时

**页面报「预测引擎不可用」** — 终端里看启动时的自检输出。多半是依赖没装上，
删掉 `.venv` 重新跑 `./run.sh` 即可。

**VARNA 出图失败** — 页头「环境」里会写明是缺 Java 还是缺 jar。
jar 可从 http://varna.lri.fr/bin/ 下载后放到 `vendor/`。

**RNAstructure 显示未安装** — 先确认 `RNASTRUCTURE_PATH` 指向的目录里有 `exe/Fold`
和 `data_tables/`。Apple Silicon 上还要装 Rosetta。

**想看后端到底返回了什么** — 在 `rna-studio` 目录下跑 `python3 selftest.py`，
它会逐个接口跑一遍并打印结果。

---

## 许可

本项目的依赖各自遵循其原始许可：

- **ViennaRNA** — 非商业用途免费，商业用途需向 ViennaRNA 团队申请许可。详见 https://www.tbi.univie.ac.at/RNA/
- **VARNA** — GPL。本项目在 `vendor/` 内分发其官方 jar，仅作调用。
- **RNAstructure** — GPL v2（由 `setup_rnastructure.sh` 从官方地址下载，不随本项目分发）。
- **FastAPI / Uvicorn** — MIT / BSD。
