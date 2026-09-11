# tests 运行说明

## 纯逻辑单测（不需要浏览器）

```bash
node tests/structure.test.mjs
```

覆盖结构树构建（stem / hairpin / internal loop / bulge / junction / exterior）、
子树、pivot、仿射变换（子树刚体旋转 + 刚体平移）、假结剔除策略、override 清理。

## 排版交互测试（Playwright，需要本地服务）

1. 起本地服务（端口与测试一致）：

   ```bash
   ./run.sh --port 8899        # 或：python -m uvicorn server.app:app --port 8899
   ```

2. 安装 playwright（两种任选）：

   ```bash
   # 方式一：就在仓库里装（测试会优先在仓库解析 playwright）
   npm i playwright && npx playwright install chromium

   # 方式二：装在别处，运行时指路
   PLAYWRIGHT_DIR=/path/to/dir node tests/ui-rotate.mjs
   ```

3. 运行：

   ```bash
   node tests/ui-rotate.mjs                      # 默认连 http://127.0.0.1:8899
   RNA_STUDIO_URL=http://127.0.0.1:9000 node tests/ui-rotate.mjs   # 换地址
   ```

覆盖：分支选择（pivot / 子树高亮 / 旋转手柄）、子树刚体旋转、非子树逐点不动、
Shift 15° 吸附、双击重置角度、右键重置分支、刚体平移、撤销逐步还原（Case 4）、
结构完整性 + 旋转期间零 API 调用（Case 5）、刷新后 layoutOverrides 恢复。
