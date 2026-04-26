---
name: machining-handbook
description: 机加工参数索引手册。任何涉及 G-code 生成、切削参数选择、工艺方案的任务**第一步必读**。包含核心公式、材料分类、刀具适配、决策树、外推规则。结合 calc_feeds_speeds.py 使用，覆盖数据库内 + 数据库外 90% 的常见场景。
---

# 机加工参数手册（LLM 索引页）

> **使用方式**：先看本手册第 4 节决策树确定路径 → 调 `calc_feeds_speeds.py` 一键查 → 数据库外的情况按第 5 节外推 → 最终用第 1 节公式做 sanity check。

## 1. 核心公式（必背 5 个）

| 量 | 公式 | 单位 | 用途 |
|---|---|---|---|
| 转速 S | `S = Vc × 1000 / (π × D)` | rpm | 由切削速度 Vc 算转速 |
| 进给率 F（多刃刀） | `F = fz × z × S` | mm/min | 立铣、面铣、铣槽 |
| 进给率 F（钻头/铰刀） | `F = fr × S` | mm/min | 钻、铰、镗 |
| 进给率 F（攻丝） | `F = pitch × S` | mm/min | G84 攻丝循环 |
| 材料去除率 MRR | `MRR = ap × ae × F` | mm³/min | 评估生产效率 |
| 估算功率 P | `P = MRR × Kc / (60000 × η)` | kW | Kc：钢 2200，铸铁 1200，铝 800；η≈0.8 |

> 记住：**切削速度 Vc 是查表的入口**（决定主轴负载/刀具寿命），**进给率 F 是配套参数**（决定表面质量/排屑）。

## 2. 数据库覆盖（calc_feeds_speeds.py 直接查）

### 2.1 材料（5 种）
```
HT150  灰铸铁 GB/T 9439     基准
HT200  灰铸铁 GB/T 9439     比 HT150 难一档
6061-T6 铝合金 GB/T 3190    通用基准
45     中碳钢 GB/T 699       通用钢基准
304    奥氏体不锈钢          难加工材料代表
```

### 2.2 刀具类型（9 种）
```
carbide_endmill                   硬质合金立铣（最常用）
hss_endmill                       高速钢立铣
coated_carbide_endmill_for_stainless  不锈钢专用涂层立铣
carbide_drill                     硬质合金钻头
hss_drill                         高速钢钻头
reamer_machine                    机用铰刀
tap                               丝锥
carbide_face_mill                 面铣刀
boring_bar                        镗刀
```

### 2.3 工序（10 种）
```
face_milling     面铣
rough_milling    粗铣
finish_milling   精铣
slot_milling     铣槽
contour_milling  轮廓铣
drilling         钻孔
deep_drilling    深孔钻（>3D，用 G83 啄式）
reaming          铰孔
threading        攻丝
boring           镗孔
```

## 3. 刀具 → 工序适配表

| 工艺需求 | 优先刀具 | 备选 | 备注 |
|---|---|---|---|
| 平面铣大面积 | `carbide_face_mill` | `carbide_endmill` 大直径 | ae 取 0.6~0.8D |
| 粗铣去除余量 | `carbide_endmill` | — | ap 大 ae 小，效率高 |
| 精铣表面 Ra1.6 | `carbide_endmill` 4 刃+ | — | ap/ae 小，转速高 |
| 铣槽（槽宽 = D） | `carbide_endmill`（直径 = 槽宽） | — | 不需要刀补 |
| 铣槽（槽宽 > D） | `carbide_endmill` 小一号 + 走刀补 | trochoidal | 防夹刀 |
| 外形轮廓 | `carbide_endmill` | — | G41 左刀补（外侧加工）|
| 型腔轮廓 | `carbide_endmill` | — | G42 右刀补 |
| 钻孔（一般） | `carbide_drill` | `hss_drill` | 通孔 Z= -(厚度+3mm) |
| 钻深孔（>3D） | `carbide_drill` + G83 | — | Q ≤ D，分层退屑 |
| 高精度孔 H7 | 钻 → 铰（`reamer_machine`）| 钻 → 镗（`boring_bar`）| 不能 endmill 直接成型 |
| 高精度孔 H6 及以上 | 钻 → 半精镗 → 精镗 | — | 必须用 boring_bar |
| 攻丝 | `tap` + G84 | — | 必须有底孔 |
| 倒角 | `carbide_endmill` 球头/锥度 | 专用倒角刀 | C2 = 2×45° |

## 4. 决策树（拿到任务后怎么走）

```
拿到任务（材料 + 特征 + 精度要求）
    │
    ├─ Step A: 材料是否在我们 5 种里？
    │   ├─ YES → 直接用代号查
    │   └─ NO → 看第 5 节"材料外推"
    │
    ├─ Step B: 工序是否在我们 10 种里？
    │   ├─ YES → 直接查
    │   └─ NO → 看第 6 节"工序拆分"
    │
    ├─ Step C: 调 calc_feeds_speeds.py 拿 S/F/ap/ae
    │
    ├─ Step D: 对照"特殊情况校正"做调整
    │   - 槽宽 > 1.5D：改 trochoidal，ae=0.05~0.1D
    │   - 孔深 > 3D：换 G83，Q ≤ D
    │   - 薄壁件：ap 减半，分层走
    │   - 球头铣曲面：F × 0.7（chip thinning）
    │   - 拐角/转角：F × 0.5
    │   - H7 精度孔：钻 → 铰/镗，不能 endmill
    │   - 高刚性新机床：可用 aggressive
    │   - 老机床/手动夹具：用 conservative
    │
    └─ Step E: 用第 1 节公式校验功率（避免超主轴能力）
        P = MRR × Kc / 60000   单位 kW
        机床主轴 ≥ 2P 才安全
```

## 5. 数据库外材料的等价折算（重要！）

> 原则：**找最相近材料，按"硬度比 × 韧性比"换算 scale 系数**。

| 不在表内的材料 | 等价于 | scale | 说明 |
|---|---|---|---|
| HT250 | HT200 | × 0.92 | 强度再高一档 |
| HT300 | HT200 | × 0.85 | 球墨铸铁特性 |
| QT500-7 / QT600-3 | HT200 | × 0.85 | 球铁韧性高，但参数类似铸铁 |
| 7075-T6 铝 | 6061-T6 | × 0.85 | 更硬更强 |
| 2A12 / 2024 | 6061-T6 | × 0.9 | 类似 |
| 5052 | 6061-T6 | × 1.05 | 稍软 |
| 7050-T7451 | 6061-T6 | × 0.8 | 高强度航空铝 |
| Q235 | 45 | × 1.1 | 低碳钢，软 |
| Q345 | 45 | × 1.05 | 略软于 45 |
| 40Cr / 42CrMo | 45 | × 0.85 | 调质合金钢 |
| 40Cr 调质 HB280+ | 45 | × 0.7 | 硬度高 |
| 20CrMnTi | 45 | × 0.9 | 渗碳钢生坯 |
| 渗碳淬火件 HRC 58+ | — | — | ⚠️ 必须磨削，不能切削 |
| 316 / 316L | 304 | × 0.9 | 含钼，更难加工 |
| 2205 双相钢 | 304 | × 0.7 | 远难于 304 |
| H62 / H68 黄铜 | 6061-T6 | × 1.2 | 易加工 |
| HPb59-1 易切削黄铜 | 6061-T6 | × 1.4 | 最易加工 |
| T1/T2 紫铜 | 6061-T6 | × 0.8 | 粘性大，刀具易磨损 |
| 尼龙 PA6 / POM | 6061-T6 | × 1.5 | 但 ap≤D，ae≤0.5D，注意排屑 |
| **TC4 钛合金** | 304 | × 0.55 | ⚠️ 不能间断切削，必须用专用涂层（AlTiN）|
| **Inconel 718** | 304 | × 0.4 | ⚠️ 高温合金，咨询用户 / 用 ceramic |
| 65Mn / 弹簧钢 | 45 | × 0.75 | 调质态 |

### 用法示例
HT250 钻孔（数据库里没有 HT250）：
```
1. 调 calc_feeds_speeds.py --material HT200 --tool carbide_drill --diameter 8 --operation drilling
   返回: S=2387, F=480
2. 套 scale × 0.92 (HT250 比 HT200 再难一档)：
   实际用 S=2196, F=441
3. G-code 注释里写 "HT250 按 HT200 等效计算 ×0.92"
```

## 6. 工序拆分规则（数据库外的工艺操作怎么处理）

| 用户要的操作 | 在数据库怎么找 | 备注 |
|---|---|---|
| 端面打孔 + 倒角 | drilling + 锥度刀走 contour | 倒角 C2 = 2×45° |
| 螺纹底孔 + 攻丝 | drilling（底孔径=螺距修正）→ threading | M6 底孔 φ5.0，M8 底孔 φ6.8（粗牙）|
| 沉头孔（埋头螺钉位） | drilling 主孔 + 锥度刀埋头 | 90°/82° 标准 |
| 沉孔（counterbore） | drilling + 平底端铣大直径短刀（counterbore tool 或 endmill 走环形） | ⌴φ20 深 5 形式 |
| 镗孔（H7+） | drilling 留余量 → boring | 留单边 0.2~0.5mm |
| 铰孔（H7~H9） | drilling 留余量 → reaming | 留单边 0.1~0.2mm |
| 长槽（多次走刀） | slot_milling 分层 | ap = 0.3~0.5D，重复走 |
| 圆环槽 | slot_milling 沿圆走 | G02/G03 圆弧插补 |
| 内圆弧 | contour_milling | 注意刀具半径 ≤ 圆弧半径 |
| 外圆弧 | contour_milling | 任意刀径 |
| 整体面加工（大平面） | face_milling | ap 0.5~2mm 多次 |

## 7. 特殊情况校正速查

```
槽宽 > 1.5×D（夹刀风险）       → trochoidal milling，ae 取 0.05~0.1×D
孔深 > 3×D                      → G83 啄钻，每次 Q ≤ D
孔深 > 5×D                      → 用枪钻，参数另查
壁厚 < 3mm（薄壁）               → ap 减半，多层加工，避免变形
球头铣曲面                       → F × 0.6~0.8（chip thinning 修正）
拐角 90°                        → 拐角处 F × 0.5，防过切
拐角 R 小                       → 用更小直径刀具或减速过弯
精度 IT7 (H7)                   → 必须铰孔或镗孔
精度 IT6 及以上                 → 必须半精镗+精镗
表面 Ra ≤ 1.6                   → 多齿精铣 + ap/ae 小
材料硬度 > HB280                → 参数 × 0.7
材料硬度 > HRC 45                → 必须用 CBN/陶瓷/PCD
间断切削（如带键槽轴）           → F × 0.7，刀具寿命减半
干切 vs 湿切                    → 看材料 preferred_coolant 字段
首件试切                         → 用 conservative 策略
批量稳定生产                     → 用 standard 策略
高刚性 + 新刀                   → 可用 aggressive
```

## 8. 工程实例（举一反三）

### 例 A：HT150 上铣 8×30 矩形槽（深 5）
```bash
python scripts/calc_feeds_speeds.py --material HT150 --tool carbide_endmill --diameter 8 --teeth 4 --operation slot_milling --strategy standard
# 输出 S=3183, F=1273, ap=3.2, ae=8 (=D, 槽宽=刀径无刀补)
```
G-code 关键段：
```
G54 G90 G80
T01 M06            (PHI8 ENDMILL)
G43 H01
S3183 M03          (HT150 干切，不发 M08)
G00 X<起点> Y<起点>
G00 Z5
G01 Z-2.5 F500     (分两层下刀，第一层)
G01 X<终点> F1273  (第一刀槽)
G01 Z-5 F500       (深下到 -5)
G01 X<返回> F1273  (第二刀完成)
G00 Z25
M30
```

### 例 B：6061-T6 钻 4×φ8 通孔（板厚 12）
```bash
python scripts/calc_feeds_speeds.py --material 6061-T6 --tool carbide_drill --diameter 8 --operation drilling --strategy standard
# 输出 S=7958, F=1592
```
G-code：
```
T03 M06
G43 H03
S7958 M03 M08      (铝必须冷却)
G00 X10 Y10
G00 Z25
G99 G81 X10 Y10 Z-15 R5 F1592   (Z=-15 = -(12+3))
X40 Y10
X40 Y40
X10 Y40
G80
G00 Z25 M09
M05
```

### 例 C：HT250（不在表）+ 镗 φ40H7 孔
查不到 HT250 → 按第 5 节套 HT200 × 0.92：
```bash
python scripts/calc_feeds_speeds.py --material HT200 --tool boring_bar --diameter 40 --operation boring --strategy conservative
# 输出 S=541, F=66 (用 conservative 因为是精度孔)
# 套 scale 0.92：实际 S=498, F=61
```
工艺：
1. 钻孔 φ38（留单边 1mm 余量）
2. 半精镗 φ39.8（留单边 0.1mm）
3. 精镗 φ40H7（一刀到位）

### 例 D：M10×1.5 攻丝 45 钢
```bash
python scripts/calc_feeds_speeds.py --material 45 --tool tap --diameter 10 --operation threading --pitch 1.5 --strategy standard
# 输出 S=318, F=477
```
工艺：先钻底孔 φ8.5（M10 粗牙底孔径 = 公称径 - 螺距），再 G84 攻丝。

---

## 9. 不要做的事（边界）

| 场景 | 为什么不做 | 应该 |
|---|---|---|
| 3D 曲面铣削 | CAM 软件领域 | 让用户用 Fusion360/Mastercam 出 G-code |
| 五轴联动 | 同上 | 同上 |
| 车削 | 另一套范式 | 单独写 turning skill |
| 磨削 | 不是切削 | 推到磨工序 |
| 渗碳淬火件加工 | 必须磨 | 跟用户确认是否在淬火前加工 |
| HRC 50+ 硬车 | 需 CBN 专用 | 让用户咨询刀具供应商 |
| 公差未明确的精密件 | 不能猜公差 | **停下问用户** |
| 特种加工（电火花/激光/水切割）| 完全另一回事 | 推到对应专家 |

---

> 📌 这个手册随项目演进。新材料/工艺需要支持时，往第 5/6 节追加规则即可，不需要改脚本。
