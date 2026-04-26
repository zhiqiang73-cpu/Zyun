---
name: 2d-milling-workflow
description: 2D 平面铣削主流程（钻孔/槽/外形/型腔），FANUC 控制器为主。当用户提供工程图 PDF 并要求生成 G-code 时启用。串联 parse_pdf、读图、特征提取、切削参数、G-code 生成、校验六个步骤。
---

# 2D 平面铣削主流程（FANUC 0i / 30i / 31i）

## 触发场景
- 输入：用户上传的 PDF 工程图（在 `uploads/` 目录）
- 输出：可直接装入 FANUC 控制器的 `.nc` 程序 + 装夹/对刀指引
- 适用：2.5D 铣削（钻孔、开槽、外形、型腔）

## 标准 0+6 步

### 步骤 0（必做！）：先 Read 机加工手册
```
Read skills/machining-handbook.md
```
这是查参数的索引页，包含：
- 5 个核心公式
- 5 种数据库内材料 + 30+ 种数据库外材料的 **scale 折算规则**
- 决策树（看 30 秒就知道下一步去哪）
- 工序拆分规则（用户的"操作 X"在我们 10 种工序里怎么映射）
- 特殊情况校正速查（薄壁/深孔/精度孔 等）
- 工程实例

**遇到任何"数据库里没有的材料/操作"**，第一反应是回 handbook 第 5/6 节，**不是问用户**。


### 步骤 1：解析 PDF
```bash
python3 scripts/parse_pdf.py uploads/<filename>.pdf
```
脚本会在 `parsed/` 写入：
- `page_<N>.png` — 每页高分辨率渲染（约 2400×3000）
- `text.json` — 每个文字块的内容 + 边界框 + 所在页码
- `meta.json` — 页数、原始尺寸等

如果 `python3` 或 `PyMuPDF` 不可用，告诉用户先 `pip install PyMuPDF` 再继续。

### 步骤 2：读图（**走 vision_call.py，不要 Claude 自己 Read 图**）

```bash
python scripts/vision_call.py parsed/page_1.png --out parsed/vision_p1.json
# 多页：parsed/page_2.png → parsed/vision_p2.json ...
```

脚本内部自动：
1. 注入 `skills/drawing-recognition.md` 作为 vision LLM 的 system prompt
2. 并行调 Qwen3.6-Plus（主）+ Kimi-K2.5（异源验）
3. DeepSeek-R1 对比两份输出，找数字/特征分歧

**Read 上一步 vision_p*.json**（不要 Read PNG），整合：
- `primary.content` 主识图结果
- `verify.content` 互验结果
- `agree=true` → 信赖；`agree=false` → 看 `disagreements` 决定下一步
- 配合 `text.json` 的 PyMuPDF 文字（确定性）做交叉验证

参考 skill `drawing-recognition.md`（vision_call.py 自动注入，但你也可以 Read 来理解）。

### 步骤 2.5：工艺规划（**识图后、写代码前必做**）
```
Read skills/process-planning.md
```
基于步骤 3 提取的特征 + 公差 + 技术要求，按 process-planning §6 五大原则编排工序：
- 选粗基准（第一道工序定位用，从毛坯面选）
- 选精基准（贯穿后续工序，常用基准统一原则）
- 划分加工阶段（粗→半精→精→光整）
- 工序顺序：基准先行 → 先粗后精 → 先面后孔 → 先主后次 → 配套加工
- 公差严的孔：H7 用钻+铰 或 粗镗+精镗，**不能 endmill 直接铣**
- 高硬度/淬火件：插入热处理工序

输出 process-planning §11 的 process_plan JSON。**没有 process_plan 不准开始写 G-code**。

### 步骤 3：特征提取（结构化）
按这个 schema 在脑里组织（不必输出 JSON 给用户）：

```yaml
stock:
  material: "6061-T6"        # 必填，未标的找标题栏 / 问用户
  size_mm: [100, 80, 12]      # W × L × H
  setup: "G54 = lower-left, top face = Z0"

features:
  - id: F1
    type: hole              # hole / slot / contour_outer / pocket / chamfer / countersink
    diameter: 10            # for hole
    position: [25, 30]      # X, Y
    depth: 12               # 深，通孔=stock.H+0.5
    thread: M10x1.5         # 可选
    tolerance: H7           # 可选
    qty: 1
  - id: F2
    type: slot
    width: 8
    length: 30
    center: [50, 40]
    angle_deg: 0
    depth: 5
  - id: F3
    type: contour_outer
    polyline: [[0,0],[100,0],[100,80],[0,80]]
    depth: 5
    direction: outside       # outside (G41 left comp) / inside (G42 right comp)
```

如果图纸**没有明确**：
- 工件零点
- 材料
- 公差严的孔的工艺（铰/镗）
- 关键尺寸

→ **停下问用户**，不要臆造。

### 步骤 4：切削参数（feeds & speeds）—— **必须用脚本，禁止心算/拍脑袋**

**对每一把刀的每一道工序，分别调用 `scripts/calc_feeds_speeds.py`**：

```bash
python scripts/calc_feeds_speeds.py \
  --material <材料代号> \
  --tool <刀具类型> \
  --diameter <直径mm> \
  --teeth <齿数，多刃刀必填> \
  --operation <工序代号> \
  --strategy standard
  # 如果是 threading 还要 --pitch <螺距mm>
```

**支持的 `--material`**（必须从这个列表选）：
`HT150` / `HT200` / `6061-T6` / `45` / `304`

**支持的 `--tool`**：
- `carbide_endmill`（硬质合金立铣，最常用）
- `coated_carbide_endmill_for_stainless`（304 不锈钢用）
- `hss_endmill`（高速钢立铣，老机床或软材料用）
- `carbide_drill` / `hss_drill`（钻头）
- `reamer_machine`（机用铰刀）
- `tap`（丝锥）
- `carbide_face_mill`（面铣刀）
- `boring_bar`（镗刀）

**支持的 `--operation`**：
- `face_milling`（面铣）/ `rough_milling`（粗铣）/ `finish_milling`（精铣）
- `slot_milling`（铣槽）/ `contour_milling`（外形/型腔轮廓）
- `drilling`（钻孔）/ `deep_drilling`（深孔，>3D 用 G83 时）
- `reaming`（铰孔）/ `threading`（攻丝）/ `boring`（镗孔）

**`--strategy`**：
- `conservative` 取低位（保守，工件刚性差/老机床/首件用）
- `standard` 取中位（默认）
- `aggressive` 取高位（高刚性机床+新刀+批量件用）

脚本输出 JSON，含 `computed.S_rpm` `computed.F_mm_per_min` `computed.ap_mm` `computed.ae_mm` 直接照用即可。

**特殊提示**：
- `material_notes.key_warnings` 字段是材料"必读须知"，必须在工艺中体现（比如 HT150 干切、304 不能减速）
- `material_notes.preferred_coolant` 决定 G-code 里 M08（湿）还是不发 M08（干）
- 如果脚本返回 `warnings`（如 RPM 偏高），需要根据机床实际能力调整或在交付里说明

### 步骤 5：写 G-code
参考 skill `gcode-fanuc.md` 的程序模板。原则：
- 工序顺序：**钻孔 → 槽 → 型腔 → 轮廓**（先内后外）
- 每把刀单独换刀块，每次换刀回安全 Z=25
- 使用 G54、G90、G21、G17 标准模态
- 程序末必有 M30

写到 `part.nc` 或按零件名 `<partname>.nc`。

### 步骤 6：校验
```bash
python3 scripts/lint_gcode.py part.nc
```
脚本检查：
- 必备模态码（G21/G90/G54）
- 程序号 O 开头、M30 结尾
- 每个 G81/G82/G83 后必有 G80
- 进给 F 是否给出
- 简单坐标范围（不会跑出常见机床行程）

报错就修，过了就交付。

## 交付清单
1. `part.nc` — 主程序
2. `setup-sheet.md` — 装夹方法、对刀步骤、刀具表（中文）
3. （可选）`feature-list.md` — 特征清单和工艺顺序，便于复核

## 边界情况
- **多视图但尺寸只标一处**：找剖视图、局部放大图，那里通常有完整尺寸
- **图纸有手写补充**：OCR 可能识别不准，关键尺寸要让用户确认
- **公差严（IT7 以上）**：H7/G6/F7 类配合孔不能直接铣，工艺改钻+铰 或 钻+镗
- **薄壁工件**：减小 ap、增加 finish pass
- **未知材料**：不要猜，问用户

## 不做的事
- 不做 3D 曲面（需要 CAM 软件）
- 不做车削（另一套范式）
- 不修改用户上传的原图
