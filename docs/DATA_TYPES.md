# Saviu 数据类型参考（DATA_TYPES）

> 读者：项目负责人和队友。解释用简体中文，所有标识符（类型、字段、表、列、reducer 名）保留英文原样。
> 依据的代码（2026-11-07 的工作区）：`shared/types.ts`、`spacetimedb/src/schema.ts`、`spacetimedb/src/reducers/*.ts`、`spacetimedb/src/{ingest,state,staff,index}.ts`、`spacetimedb/src/fusion/*`、`engine/src/{infer,interval,features,config}.ts`、`engine/scripts/calibrate.ts`、`docs/DATA.md`、`data/**`。文中的数量是对 `data/` 里的实际文件计数得到的。
> 代码和文档对不上或不清楚的地方，统一列在文末「附录 B」。

## 标签说明（"数据性质"一列）

| 标签 | 含义 |
|---|---|
| 真实 | 直接来自公开数据集（普查、NCES、OSM、USGS 等），见第 2 节 |
| 真实派生 | 由真实公开数据计算出来（例如地震格子的 `hazardIndex`） |
| 合成 | 模拟器生成：所有住户/投保人、飓风事件、真相、短信、理赔、现场报告、基站中断、分析员分区。真实地区的住户属性"按普查区真实比例抽样"，但每个个体都是假的 |
| 模型输出 | 引擎（`engine/`）算出的估计，或回测校准的结果 |
| 演示状态 | 演示运行时产生的状态：回放时钟、成员、派单、跟进、模拟员工计数器、事件行的元数据等 |

Harbor Bend（`data/live.json` 和 `data/backtest/`）是虚构小镇，**所有字段都是合成的**，连坐标也只是为了能放到底图上。

---

## 1. 总览：数据怎么流动

```
① 真实公开数据（Census P.L.94-171 / ACS / LODES / CDC SVI / NCES EDGE / IPEDS / OSM / AWS Terrain / USGS ShakeMap / CGS 液化区）
     │  sim/real/fetch.ts 下载并缓存到 data/raw/（已 gitignore，不属于数据契约）
     ▼
② 模拟器
     sim/real/*（真实地理：tx-corpus-christi、ca-bay-area）    sim/src/*（Harbor Bend，全部虚构）
     生成：合成住户、灾害场景（飓风是假想路径；地震用 USGS 情景）、真相 TruthRow、
           sms_sent / sms_reply（含多语言自由文本）/ claim / field_report（只在回测里有）
     │
     ▼
③ EventBundle JSON（shared/types.ts 的 EventBundle = { world, events, truth }）
     live.json（演示事件） + backtest-N.json（历史回测事件） + sim-meta.json（模拟器诊断，契约之外，引擎不能读）
     │  engine/scripts/calibrate.ts：只读 backtest，留一事件（LOEO）训练和评估；holdout 住户永不参与训练
     ▼
④ model.json（ModelParams：45 个特征的两组逻辑回归权重、sourceTrust、calibration 指标、
               cellOverdispersion、cellIntervalTail）
     │  spacetimedb/scripts/seed.ts 依次调用 seed_world / seed_hexes / seed_facilities / seed_households /
     │  seed_truth / seed_staged_events / load_model（只有 owner 能调）
     ▼
⑤ SpacetimeDB 表
     私有：config、sim_truth、staged_event、cell_agg、replay_tick、staff_contact
     公开：world、hex、household、facility（静态） + 事件表 + 输出表 + 演示状态表
     │  replay_tick（每秒一次）按 t 释放 staged_event → onEvent()（ingest.ts，唯一的写入口）
     │  → recomputeCells()（fusion/index.ts，调用复制进来的引擎 spacetimedb/src/fusion/engine/）
     │  其他写入口：投保人页面 submit_*_reply、理赔员 submit_field_report、模拟员工 staff.ts、
     │  Claude 解析 worker（scripts/claude-worker.ts）：reply_inbox → submit_parsed_reply
     ▼
⑥ 公开输出：hex_stats、household_estimate、inspection_candidate、unaccounted_queue、
            household_followup、metrics、model_state、replay_state、staff_sim
     │  客户端用 spacetimedb/bindings/（自动生成的 TS 绑定）订阅 SQL
     ▼
⑦ 前端：经理看板、理赔员手机、投保人短信页。本仓库没有前端代码，只有 docs/preview/map-preview.html 预览页。
```

每个数据库只装一个世界（同一个模块发布三次）：Harbor Bend（`data/live.json` + `data/model.json`）、Corpus Christi（`data/real/tx-corpus-christi/`）、Bay Area（`data/real/ca-bay-area/`）。

---

## 2. 真实数据来源

### 2.1 `world.dataSources` 逐条说明

用 Python 读取了 `data/real/tx-corpus-christi/live.json`（10 条）和 `data/real/ca-bay-area/live.json`（12 条）的 `world.dataSources`。两区前 10 条完全相同，Bay Area 多出 2 条地震数据。Harbor Bend 的 bundle 没有 `dataSources` 字段（全部虚构）。

| # | 数据集 | 年份/版本 | 在项目里的用途 | 地区 | 许可 / 署名 |
|---|---|---|---|---|---|
| 0 | `SYNTHETIC: ...` 声明 | – | 每个真实地区 bundle 的第一条：灾害事件、每个住户/投保人、短信回复、理赔、现场报告都是模拟的；地理、人口、设施和灾害输入是真实公开数据 | 两区 | – |
| 1 | U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171)：block/tract 内点、POP100、HU100 | 2020 | 选格子、人口在格子内的分布、住户落点、`tractGeoid` | 两区 | 公有领域 |
| 2 | U.S. Census Bureau, ACS 2020–2024 5-year，表 B01001、B11001、B11005、B11007、B25024、B25034、B18101、B08201、C16001、C16002、B25003、B25032、B14007 | 2020–2024 | 每个住户属性的普查区比例（年龄、独居、孩子、残障、无车、移动房屋、房龄、租住/自有、语言、在读大学） | 两区 | 公有领域 |
| 3 | 2020 Census P.L. 94-171 表 P5（集体宿舍），P5_008N 大学宿舍 | 2020 | 提高校园附近的 `collegeStudent` 概率 | 两区 | 公有领域 |
| 4 | NCES IPEDS 2023：HD2023 + EF2023A（EFALEVEL=1，EFTOTLT） | Fall 2023 | `Facility` kind `university` 及其招生数，`HexCell.collegeEnrollment` | 两区 | 公有领域 |
| 5 | LEHD LODES8 2023，WAC 和 RAC（S000, JT00） | 2023 | `HexCell.daytimeWorkers`、`residentWorkers`，`Household.awayDaytime` 的概率 | 两区 | 公有领域 |
| 6 | CDC/ATSDR Social Vulnerability Index 2022（tract）：EP_DISABL、RPL_THEMES | 2022 | 按残障率缩放 `medicalDevice` 的比例 | 两区 | 要求署名 "CDC/ATSDR Social Vulnerability Index 2022 Database"（原文没有写公有领域） |
| 7 | NCES EDGE Public School Administrative Data 2023-24 | 2023–24 | 学校设施（名称、位置、`enrollment`），`HexCell.k12Enrollment`，`Household.nearestSchoolId` | 两区 | 公有领域 |
| 8 | OpenStreetMap（Overpass API）：医院、消防站、避难所、通信塔、海岸线 | 2026-11-07 抓取 | `Facility` kind `hospital`/`fire_station`/`shelter`/`mast`；海岸线（洪水、风衰减）；基站中断主簇放在真实塔位上 | 两区 | **© OpenStreetMap contributors, ODbL 1.0**。派生数据也受 ODbL 约束，展示地图或数据时必须署名 |
| 9 | Terrain Tiles on AWS Open Data（Terrarium, zoom 12；USGS 3DEP/NED、SRTM、GMTED2010、ETOPO1） | 静态 | 每格平均高程（算洪水深度和内涝洼地） | 两区 | 按 registry 页面要求署名 |
| 10 | USGS ShakeMap 情景目录（HayWired M7.05、BSSC2014 / legacy 湾区情景），grid.xml MMI | HayWired v33 (2017)；BSSC2014 | `HexCell.shakingMmi` | 仅 Bay Area | 公有领域 |
| 11 | California Geological Survey, Seismic Hazard Zones: Liquefaction Zones | 2025 编辑 | `HexCell.liquefaction`（每格 7 个采样点落在液化区内的比例） | 仅 Bay Area | California Department of Conservation / CGS |

`Facility.source` 字段的实际取值：`OpenStreetMap`、`NCES EDGE 2023-24`、`IPEDS 2023 (HD2023, EF2023A)`。

### 2.2 哪些是真实的，哪些是合成的（来自 `docs/DATA.md`）

| | 真实（公开数据） | 合成（模拟器） |
|---|---|---|
| 地理 | 真实街区/普查区上的 H3 格子、OSM 海岸线、地形 | Harbor Bend 整个小镇 |
| 人 | 每个普查区的 ACS/普查分布、LODES 白天上班人数、CDC SVI | 每个住户和投保人（按这些分布抽样） |
| 地点 | NCES 学校、IPEDS 大学、OSM 医院/消防站/避难所/通信塔 | – |
| 灾害 | USGS ShakeMap HayWired M7.05 的 MMI 网格、CGS 液化区 | Corpus Christi 飓风（假想 Cat 4 路径）、Harbor Bend 飓风、所有基站中断 |
| 灾后 | – | 损失和需求（truth）、人在哪里、短信回复及文本、理赔、现场报告、演示时模拟员工的电话和上门 |

另外，保险覆盖标志（`windCovered` 97%、`floodPolicy`、加州 `earthquakeEndorsement` 12%）和 `phoneOnFile` 88% 都是假设值，没有用任何保单数据。

---

## 3. 共享数据合约（`shared/types.ts`）

文件头注释说明：这是所有模块（模拟器、引擎、Spacetime 模块、前端）共用的契约，改之前先告诉队友；全部数据都是合成的，不含真实客户信息。标"v2 可选"的字段只有真实地图版数据才有；"v3"是加入需求类型、人在哪里、回复标签的那一轮改动。

### 3.1 基础类型别名

| 类型 | 定义 | 含义 / 取值 |
|---|---|---|
| `HexId` | `string` | H3 索引，分辨率 8（每格约 0.7 km²），例如 `8848906c01fffff` |
| `Minutes` | `number` | 距飓风登陆（地震则是发生时刻）的分钟数。数据里都是整数，0–4320（72 h） |
| `Damage` | `0 \| 1 \| 2 \| 3` | 0 无损，1 轻微，2 严重，3 无法居住。"严重受损"指 damage ≥ 2 |
| `Safety` | `'safe' \| 'needs_help' \| 'unsure'` | `unsure` 只出现在现场报告里（查勘了房子但没见到人） |
| `Priority` | `'P0' \| 'P1' \| 'P2'` | 需要多快采取行动，P0 最急 |
| `Verification` | `'verified' \| 'needs_verification'` | 信息够不够（格子级别） |
| `Peril` | `'wind' \| 'flood' \| 'earthquake'` | 灾种 |
| `HazardType` | `'hurricane' \| 'earthquake'` | 世界的灾害类型 |
| `NeedType` | `'life_safety' \| 'assistance' \| 'none'` | v3，见 `TruthRow.needType` |
| `Whereabouts` | `'home' \| 'away' \| 'displaced'` | v3，见 `TruthRow.location` |
| `Need` | `'medical' \| 'power_for_device' \| 'shelter' \| 'water_food' \| 'transport' \| 'inspection' \| 'other'` | v3，回复里提到的具体需求（不是生命危险），见第 7 节 |

### 3.2 `HexCell`（一个 H3 格子）

| 字段 | 类型 | 含义 | 取值 / 单位 | 数据性质 |
|---|---|---|---|---|
| `hex` | `HexId` | 格子 ID | H3 res 8 | HB 合成；真实地区是真实的 H3 格子 |
| `lat`, `lng` | `number` | 格子中心坐标 | 度，6 位小数 | 同上 |
| `windMph` | `number` | 峰值风速 | mph，整数；HB 约 40–140；地震世界为 0 | 合成（所有飓风都是假想的） |
| `floodDepthFt` | `number` | 洪水深度 | ft，精确到 0.1；低于 0.5 ft 记为 0（没淹）；地震世界为 0 | 合成（真实地区用了真实地形高程） |
| `towerOutagePct` | `number` | 基站中断比例 | 0–100 整数。飓风 85·sigmoid((wind−116)/8)，地震 80·sigmoid((MMI−9.2)/0.25)，再叠加中断簇 | 合成（真实地区的主簇放在真实 OSM 塔位上） |
| `analystZone` | `0 \| 1 \| 2` | 人工标注的受灾区：0 无，1 中度，2 严重 | 由预报路径（侧移 1–2 km）或平滑后的 ShakeMap 生成，故意含错 | 合成 |
| `hazardIndex?` | `number` | v2：不分灾种的 0–1 强度，引擎优先用它 | `clamp(score/3.2, 0, 1)`，3 位小数；只有真实地区有 | 飓风：合成；地震：真实派生（ShakeMap + CGS） |
| `shakingMmi?` | `number` | 地震：修正麦加利烈度 | MMI，2 位小数；只有 Bay Area 有 | 真实（USGS 情景，不是实际发生的地震） |
| `liquefaction?` | `number` | 地震：液化易发程度 | 0–1（7 个采样点落在 CGS 液化区内的比例）；只有 Bay Area 有 | 真实 |
| `tractGeoid?` | `string` | 贡献人口最多的普查区 | 11 位 GEOID，例如 `48355006000` | 真实 |
| `daytimeWorkers?` | `number` | 在这个格子里上班的人数 | LODES WAC | 真实 |
| `residentWorkers?` | `number` | 住在这个格子里的在职人数 | LODES RAC | 真实 |
| `k12Enrollment?` | `number` | 格子内中小学在校生总数 | NCES | 真实 |
| `collegeEnrollment?` | `number` | 格子内大学在校生总数 | IPEDS | 真实 |

`hazardIndex` 里的 score（`sim/real/simulate.ts`）：飓风 `max(w,f) + 0.3·min(w,f)`，其中 `w = max(0,(windMph−60)/26)`，`f = floodDepthFt/2.7`；地震 `max(0,(MMI−6.8)/1.6) + 0.8·liquefaction·clamp((MMI−6.5)/1.5,0,1)`。Harbor Bend 没有 `hazardIndex`，引擎改用 v1 公式（见 8.2）。

### 3.3 `Facility`（v2：真实设施）

| 字段 | 类型 | 含义 | 取值 | 数据性质 |
|---|---|---|---|---|
| `id` | `string` | 设施 ID | 例如 `tx-corpus-christi-fire_station-001`、`ca-bay-area-school-110` | 项目生成的 ID |
| `kind` | 枚举 | 设施类型 | `school`、`university`、`hospital`、`shelter`、`fire_station`、`mast` | 真实 |
| `name` | `string` | 名称 | 例如 "Annaville Fire Department" | 真实 |
| `lat`, `lng` | `number` | 坐标 | 度 | 真实 |
| `hex` | `HexId` | 所在格子 | | 真实派生 |
| `enrollment?` | `number` | 在校生人数 | 只有学校和大学有（CC 的 170 个设施里 92 个有，CA 的 605 个里 322 个有） | 真实 |
| `capacity?` | `number` | 容量 | **现有数据文件里一次都没出现过** | – |
| `source` | `string` | 数据来源 | 见 2.1 末尾 | 真实（元数据） |

实际数量：Corpus Christi 170 个（school 90、mast 42、fire_station 22、hospital 13、university 3）；Bay Area 605 个（school 318、mast 168、fire_station 74、hospital 18、university 17、shelter 10）；Harbor Bend 0 个。

### 3.4 `Household`（住户 / 投保人）

全部是**合成**个体。真实地区的属性按所在普查区的真实 ACS 比例抽样；Harbor Bend 用固定比例（见 `data/README.md`）。

| 字段 | 类型 | 含义 | 取值 / 说明 |
|---|---|---|---|
| `id` | `string` | 住户 ID | HB 是 `<eventId>-h00001`（例如 `live-h00001`、`backtest-1-h00001`）；真实地区是 `tx-live-h000001`、`ca-backtest-1-h000001` 这种 |
| `hex` | `HexId` | 所在格子 | |
| `lat`, `lng` | `number` | 坐标 | HB 是格子内的随机点；真实地区按人口选普查街区内点，再抖动最多 120 m |
| `age65` | `boolean` | 家里有 65 岁以上的人 | HB 20%；真实地区用 B11007 |
| `livesAlone` | `boolean` | 独居 | HB：65+ 时 25%，否则 10% |
| `medicalDevice` | `boolean` | 依赖医疗设备（注释：客户自己提供、同意使用的信息） | HB：65+ 9%，否则 2.75%；真实地区再按 SVI 残障率缩放 |
| `windCovered` | `boolean` | 房屋险保风灾 | 97%（假设） |
| `floodPolicy` | `boolean` | 另买了洪水险 | 离海岸越近越高（假设） |
| `earthquakeEndorsement` | `boolean` | 有地震附加险（飓风场景里只做展示） | HB 5%，加州 12%（假设） |
| `phoneOnFile` | `boolean` | 登记了手机号（才会收到短信） | 88% |
| `holdout` | `boolean` | true 表示只用来评估，永远不参与训练 | 15%（HB 每个世界正好 450 户）；回测里 holdout 住户不会有现场报告 |
| `tractGeoid?` | `string` | v2：所属普查区 | |
| `childrenUnder18?` | `boolean` | v2：家里有 18 岁以下的孩子 | ACS B11005 |
| `awayDaytime?` | `boolean` | v2：白天通常不在家（通勤上班等） | LODES；只有工作日上班时间发生的事件才起作用 |
| `age75?` | `boolean` | v2 CMIST：75 岁以上 | |
| `disability?` | `boolean` | 残障或行动不便 | ACS B18101 |
| `noVehicle?` | `boolean` | 家里没车，难以撤离 | ACS B08201 |
| `limitedEnglish?` | `boolean` | 英语能力有限 | ACS C16002 |
| `primaryLanguage?` | `string` | 住户的主要语言，也是自由文本回复的语言（模拟的问候短信只用英语，按此语言外联在路线图上） | `en es zh vi tl ko fr de ru ar other-ie other-api other`（见第 7 节） |
| `mobileHome?` | `boolean` | 住移动房屋（风灾下最脆弱） | ACS B25024 |
| `policyType?` | `'homeowners' \| 'renters' \| 'condo'` | 保单类型。租户只保财物和临时住宿，房屋结构归房东的保险 | ACS B25003；condo 是用多户住宅比例做的代理估计 |
| `schoolAgeChildren?` | `number` | 5–17 岁的孩子人数 | 整数 ≥ 0 |
| `collegeStudent?` | `boolean` | 大学生住户（常为租户、无车、白天不在） | B14007 + P5_008N |
| `nearestSchoolId?` | `string` | 最近学校的 `Facility.id`（家庭团聚信息、避难所转介） | |

Harbor Bend 的住户只有前 12 个必填字段；两个真实地区的住户所有可选字段都填了。

### 3.5 `World`

| 字段 | 类型 | 含义 | 取值 | 数据性质 |
|---|---|---|---|---|
| `eventId` | `string` | 事件 ID | `live`、`backtest-1` … | 合成 |
| `name` | `string` | 名称 | HB 是虚构地名（"Harbor Bend, TX"、"Pelican Point, TX" 等）；真实地区是情景名（例如 "HayWired M7.05 Hayward Fault scenario (USGS ShakeMap), Alameda County, CA"） | 合成 |
| `landfallIso` | `string` | 登陆/发生时间（ISO，UTC） | 例如 `2026-11-07T04:00:00.000Z` | 合成 |
| `center` | `{ lat, lng }` | 地图中心 | | 合成 |
| `hexes` | `HexCell[]` | 全部格子 | HB 331、CC 449、CA 611 | 见 3.2 |
| `households` | `Household[]` | 全部住户 | 见第 4 节 | 合成 |
| `region?` | `string` | v2：地区 | `tx-corpus-christi`、`ca-bay-area`；HB 没有 | 元数据 |
| `hazardType?` | `HazardType` | 灾害类型；旧数据没有这个字段，按 hurricane 处理 | | 元数据 |
| `facilities?` | `Facility[]` | 真实设施 | | 真实 |
| `dataSources?` | `string[]` | 真实数据来源和许可说明 | 见 2.1 | 真实（元数据） |
| `horizonMinutes?` | `number` | 事件时长，缺省 4320（72 小时） | **现有 bundle 都没设**，所以全部是 4320 | – |
| `eventLocalHour?` | `number` | 灾害发生时的当地小时（0–23），决定 `awayDaytime` 是否起作用 | CC live 为 2；CA live 为 10 | 合成 |
| `eventWeekday?` | `boolean` | 是否工作日（上课时间 + 工作日 = 孩子在学校） | CC live false；CA live true | 合成 |

### 3.6 `TruthRow`（真实情况，只有模拟器知道）

引擎只在训练（回测事件）和评估（留出住户）时读取它。在数据库里它存进私有表 `sim_truth`。全部是**合成**数据。

| 字段 | 类型 | 含义 | 取值 |
|---|---|---|---|
| `householdId` | `string` | 住户 | |
| `damage` | `Damage` | 真实损失 | 0–3 |
| `safety` | `'safe' \| 'needs_help'` | 是否需要帮助 | |
| `peril` | `Peril \| 'none'` | 造成损失的灾种 | HB 里 damage 0 的是 `none`；Bay Area live 里 28,885 户是 `earthquake`，1,115 户是 `none`（没核对是否所有 damage 0 都是 `none`） |
| `needType?` | `NeedType` | v3：需要帮助的类型。`life_safety` = 现在就有危险（转 911 / 当地机构）；`assistance` = 需要协助（住所、供电、药品、交通），由 State Farm 客服跟进；`none` = 不需要 | 现有全部 bundle 都有 |
| `location?` | `Whereabouts` | v3：灾后响应期间人在哪里。`home` 在家；`away` 灾害发生时不在家（上班/上学），看不到房子；`displaced` 房子受损已离开（知道损失） | 只有 CA live 里有 `away`（17,353 户） |
| `returnMin?` | `number` | v3：`away` 的人回到家的模拟分钟。回家后房子 damage ≥ 2 的人会再离开（变成 displaced），否则留在家 | 只出现在 `away` 的行（模拟器设定 4–12 h 后回家）；数据库里缺失时存 −1 |

### 3.7 `SimEvent`（事件，按 `kind` 区分的联合类型）

所有事件都有 `kind`、`t: Minutes`、`householdId: string`。bundle 里的事件全部是**合成**的；数据库里 `source = 'live'` 的事件是演示时提交的（演示状态）。

| `kind` | 额外字段 | 含义 |
|---|---|---|
| `sms_sent` | 无 | 给这户发了外联短信（只发给 `phoneOnFile` 的住户；飓风在 60–180 min，地震在 20–120 min） |
| `sms_reply` | 见下表 | 住户回复了（或坐席电话联系上了） |
| `claim` | `peril: Peril`，`reportedDamage: Damage` | 理赔申请：申报的灾种和损失（申报值有 ±1 的噪声） |
| `field_report` | `adjusterId: string`，`safety: Safety`，`damage: Damage \| null` | 理赔员现场报告。`damage` 是房子的查勘结果（等于真相）；`null` = 只看了人、没评估房子（夜里 / 进不去），房子仍算未查勘；`safety` 是见到的住户状态，`unsure` = 没见到人。同一户的多条报告：住户状态取最新一条，房子损失保留最近一条评估过的。**只出现在回测文件里**；live 里的现场报告在演示时由理赔员或模拟员工产生。回测的 `adjusterId` 形如 `adj-01` |

`sms_reply` 的字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `safety` | `'safe' \| 'needs_help'` | 回复表达的安全状态 |
| `damage` | `Damage \| null` | v3：null 表示回复没有描述房子（例如人不在家，或只说"我们没事"），损失未知 |
| `lifeSafety?` | `boolean` | v3：有生命危险的信号（被困、受伤、煤气、医疗设备断电、泛泛的"救命"） |
| `needs?` | `Need[]` | v3：具体需求（不是生命危险） |
| `notHome?` | `boolean` | v3：回复的人不在房子里（人和房子分开：人安全 ≠ 房子已查勘） |
| `channel?` | `'sms' \| 'call'` | v3：`call` = 坐席电话联系上。**bundle 里全部是 `sms`**，`call` 只由数据库里的模拟员工产生 |
| `text?` | `string` | v2：自由文本回复（可能是多语言），由 Claude 解析成 safety/damage/needs。HB 没有；CC 有 2,517 条，CA 有 1,812 条 |
| `language?` | `string` | v2：回复所用的语言（和 `text` 一起出现） |

`events` 按 `t` 升序排列；同一分钟内按 kind（`sms_sent` < `sms_reply` < `claim` < `field_report`）再按 householdId 排（见 `data/README.md`）。

### 3.8 `EventBundle`

这是 `data/live.json`、`data/backtest/*.json`、`data/real/*/live.json`、`data/real/*/backtest-*.json` 的格式：

| 字段 | 类型 | 含义 |
|---|---|---|
| `world` | `World` | 世界（静态数据） |
| `events` | `SimEvent[]` | 按 t 升序 |
| `truth` | `TruthRow[]` | 每户一行。live 事件的 truth 只用于演示里的留出集评估（以及 `metrics.intervalCoverageLive`） |

### 3.9 `ModelParams`（`model.json`：回测校准后的模型参数）

全部是**模型输出**。

| 字段 | 类型 | 含义 |
|---|---|---|
| `version` | `number` | 模型版本，三个文件目前都是 2 |
| `features` | `string[]` | 特征名，顺序和权重一一对应（45 个，见附录 A.4） |
| `severe` | `{ bias, weights[] }` | 预测 P(damage ≥ 2) 的逻辑回归（原始特征空间） |
| `needsHelp` | `{ bias, weights[] }` | 预测 P(safety = needs_help) |
| `sourceTrust` | `{ hazard, sms, claims }` | 0–1，展示用的数据源可信度。等于 1 − Brier，Brier 用各数据源对 P(severe) 的"意见"算：hazard 用灾害分，sms 用回复 damage/3，claims 用申报 damage/3；只算非 holdout 住户 |
| `calibration` | 对象 | 见下表 |
| `cellOverdispersion?` | `number` | v3：格子层面的共享误差方差 τ²（超出二项分布的部分，相对于未核实户预期严重数的平方），用留一事件回测的矩估计得到 |
| `cellIntervalTail?` | `number` | v3：区间每一侧的尾概率。线上固定为 0.05（标准 90% 区间）；回测校准出的更窄值只作参考 |
| `region?` | `string` | v2：这个模型对应的地区 |
| `hazardType?` | `HazardType` | 对应的灾害类型 |
| `trainedOn` | `string[]` | 用了哪些回测事件 |

`calibration` 的子字段。所有数都是留一事件（LOEO）的均值，不是训练集内的数；用全部住户；默认把快照时间 360/720/1440/2880 min 汇总在一起：

| 字段 | 类型 | 含义 |
|---|---|---|
| `brier` | `number` | severe 模型的 Brier 分数，即 (p − y)² 的均值，越低越好 |
| `ece` | `number` | expected calibration error，10 个等宽分箱 |
| `heldOutEvent` | `string` | 例如 `leave-one-event-out:backtest-1,...,backtest-10` |
| `auc?` | `number` | v2：severe 模型的 AUC |
| `needsHelp?` | `{ brier, ece, auc }` | needsHelp 模型的同样三个指标 |
| `baseline?` | `{ brier, ece, auc }` | 基线模型。类型注释写的是"只看灾害强度"；代码里实际用的是 hazard + static 两组特征（"地图 + 保单档案"，不含短信和理赔） |
| `brierCI?`, `aucCI?`, `eceCI?` | `[number, number]` | v3：95% 置信区间。在每个留出事件内按格子做聚类 bootstrap（B = 300），对"各折均值"取 2.5% 和 97.5% 分位 |
| `brierRange?` | `[number, number]` | 各次留一事件的最小/最大 Brier（反映事件之间的真实差异，不是抽样误差） |
| `bss?` | `number` | Brier skill score = 1 − brier / 基线 brier（各折均值）。不受事件强度影响，更好比较 |
| `bssRange?` | `[number, number]` | 各折 BSS 的最小/最大 |
| `cellIntervalCoverage?` | `number` | 格子严重户数 90% 区间在留出事件上的实际覆盖率（应接近 0.9）。嵌套 LOEO：每一折的 τ² 和 tail 都只用其他折来选 |
| `cellIntervalMeanWidth?` | `number` | 区间的平均宽度（hi − lo，单位：户） |

三个 `model.json` 的当前值：

| | Harbor Bend `data/model.json` | Corpus Christi | Bay Area |
|---|---|---|---|
| `region` / `hazardType` | `harbor-bend` / hurricane | `tx-corpus-christi` / hurricane | `ca-bay-area` / earthquake |
| `trainedOn` | backtest-1 … backtest-10 | backtest-1 … backtest-8 | backtest-1 … backtest-5 |
| severe `brier` / `ece` / `auc` | 0.0581 / 0.0165 / 0.954 | 0.0417 / 0.0044 / 0.931 | 0.1017 / 0.0185 / 0.882 |
| `brierCI` | [0.0553, 0.0618] | [0.0402, 0.0433] | [0.0992, 0.1045] |
| baseline `brier` / `auc` | 0.0782 / 0.914 | 0.0550 / 0.851 | 0.1240 / 0.820 |
| `bss` | 0.246 | 0.208 | 0.175 |
| needsHelp `brier` / `auc` | 0.0259 / 0.834 | 0.0294 / 0.865 | 0.0256 / 0.869 |
| `sourceTrust` hazard / sms / claims | 0.851 / 0.930 / 0.895 | 0.933 / 0.939 / 0.899 | 0.862 / 0.904 / 0.889 |
| `cellOverdispersion` | 0.0120 | 0.0013 | 0.0083 |
| `cellIntervalTail` | 0.05 | 0.05 | 0.05 |
| `cellIntervalCoverage` | 0.968 | 0.976 | 0.954 |
| `cellIntervalMeanWidth`（户） | 0.97 | 1.32 | 3.84 |

### 3.10 `HouseholdEstimate`（每户估计；模型输出）

| 字段 | 类型 | 含义 | 取值 |
|---|---|---|---|
| `householdId` | `string` | 住户 | |
| `pSevere` | `number` | P(damage ≥ 2) | 0–1 |
| `pNeedsHelp` | `number` | P(safety = needs_help) | 0–1 |
| `uncertainty` | `number` | 越大越拿不准 | 0–1 |
| `verified` | `boolean` | 有现场报告 | |
| `inspectScore?` | `number` | v2：主动查勘的推荐分（数据库里总是有值） | 0–1，已核实的户为 0 |

计算方法见第 8 节。

### 3.11 `HexEstimate`（每格估计；模型输出）

| 字段 | 类型 | 含义 | 取值 |
|---|---|---|---|
| `hex` | `HexId` | 格子 | |
| `households` | `number` | 住户数 | |
| `expectedSevere` | `number` | 预计严重受损的户数 = Σ pSevere | ≥ 0 |
| `severeLo?`, `severeHi?` | `number` | v3：严重受损户数的 90% 区间下界/上界（整数户） | |
| `maxPNeedsHelp` | `number` | 格子内最大的 pNeedsHelp | 0–1 |
| `severity` | `number` | 严重程度 | 0–1 |
| `confidence` | `number` | 信心 | 0–1 |
| `priority` | `Priority` | P0/P1/P2 | |
| `verification` | `Verification` | 是否需要核实 | |
| `silence` | `number` | 应有信号却没有信号的程度 | 0–1 |
| `counts` | `{ smsSent, smsReplies, claims, fieldReports }` | 按户去重的计数 | |
| `hazard?` | `number` | v2：0–1 灾害分，验证规则用它 | |
| `reason?` | `string` | v2：给界面的一句话解释（英文），例如 `suspected P0: high hazard (82%) and silent; ...` | |
| `silenceCause?` | `'away' \| 'trapped' \| 'outage' \| 'unknown'` | v2：沉默的主要原因；silence < 0.2 时不设 | |

---

## 4. 数据文件（`data/`）

### 4.1 每个地区有哪些文件（实际计数）

| 地区 / 目录 | `live.json` | `backtest-N.json` | `model.json` | `sim-meta.json` |
|---|---|---|---|---|
| Harbor Bend（虚构）：`data/`、`data/backtest/` | 1（1.5 MB） | **10**（`data/backtest/backtest-1 … backtest-10.json`，各约 1.6 MB） | 1 | 1 |
| Corpus Christi：`data/real/tx-corpus-christi/` | 1（16.9 MB） | **8**（各约 13 MB） | 1 | 1 |
| Bay Area：`data/real/ca-bay-area/` | 1（23.9 MB） | **5**（各约 13 MB） | 1 | 1 |

另外还有 `data/eval/sms_parse_adversarial.jsonl`（1 个文件，40 行）。`data/raw/` 是公开数据的下载缓存（acs、cgs、elev、ipeds、lodes、nces、osm、pl、svi、usgs 子目录和 `fetch-status.json` 等），已被 `.gitignore` 忽略，不是契约文件。

### 4.2 每种文件是什么，顶层结构

| 文件 | 是什么 | 顶层结构 | 数据性质 |
|---|---|---|---|
| `live.json` | 演示用的"实时"事件。有 `sms_sent`、`sms_reply`、`claim`，**没有 `field_report`**（演示时由理赔员或模拟员工产生）。`truth` 只用于留出集评估 | `EventBundle`：`{ world, events, truth }` | 合成（真实地区的 world 里，地理、设施、来源说明是真实的） |
| `backtest-N.json` | 过去的灾害事件。每个都是独立的世界（种子、路径/情景、强度各不相同），带完整 truth，外加非 holdout 住户中 12% 的 `field_report`（约占全部住户的 10%：HB 每个 306 条，真实地区每个 1,530 条）。只给 `calibrate.ts` 训练和评估用 | `EventBundle` | 合成 |
| `model.json` | 引擎的 `ModelParams`（归引擎所有，不归模拟器） | `{ version, features, severe, needsHelp, sourceTrust, calibration, cellOverdispersion, cellIntervalTail, region, hazardType, trainedOn }` | 模型输出 |
| `sim-meta.json` | 模拟器诊断：故意放的偏差在哪里、沉默重灾格子在哪里，供演示讲解用。**不属于契约，引擎不能读，也不能拿来训练** | HB：`{ note, worlds[11] }`，每个元素是 `{ eventId, trackOutageCenterHex, underMarkedCenterHex, underMarkedHexes[], overMarkedCenterHex, overMarkedHexes[], overReportingDistrictCenterHex, overReportingDistrictHexes[], silentSevereHexes[] }`。真实地区：`{ note, region, studyArea: string[], fallbacks: [], worlds[] }`（CC 9 个、CA 6 个），每个元素多了 `hazardType`、`reunificationHouseholds: number`、`notes: string[]`，没有 `silentSevereHexes` | 合成（诊断信息） |
| `eval/sms_parse_adversarial.jsonl` | 40 条手写的难例，用来评估 Claude 短信解析器（en 20、es 6、zh 5、vi 3、tl 3、ko 3） | 每行 `{ id, language, text, expected: { life_safety, safety, damage, needs, not_home, missing_people }, why }`。`expected.safety` 可以是 `safe` / `needs_help` / `unsure`；`damage` 可以是 null | 合成（人工编写） |

### 4.3 每个 bundle 的规模（实际计数）

| 文件 | 灾害 / 当地时间 | 格子 | 住户 | 设施 | 事件（sent / reply / claim / field） | truth |
|---|---|---|---|---|---|---|
| `data/live.json` | 飓风（没有 hazardType 字段，按 hurricane），夜间 | 331 | 3,000 | 0 | 4,620（2,604 / 1,366 / 650 / 0） | 3,000 |
| `data/backtest/backtest-1..10` | 飓风 | 331 | 3,000 | 0 | 4,780–5,058（每个有 306 条 field） | 3,000 |
| `tx-corpus-christi/live.json` | 飓风，凌晨 2 时，周末 | 449 | 20,000 | 170 | 33,249（17,549 / 9,944 / 5,756 / 0） | 20,000 |
| `tx-corpus-christi/backtest-1..8` | 飓风，Cat 1–4，路径各不相同 | 449 | 15,000 | 170 | 23,493–25,481（每个有 1,530 条 field） | 15,000 |
| `ca-bay-area/live.json` | 地震 HayWired M7.05，10 时，工作日 | 611 | 30,000 | 605 | 35,994（26,460 / 7,381 / 2,153 / 0） | 30,000 |
| `ca-bay-area/backtest-1..5` | 地震，不同的 USGS 情景 | 611 | 15,000 | 605 | 21,173–23,308（每个有 1,530 条 field） | 15,000 |

Harbor Bend 的 bundle 没有任何 v2 字段（没有 region、hazardType、facilities、dataSources、eventLocalHour、eventWeekday；住户和格子也没有可选字段），回复里没有 `text`/`language`，`damage` 从不为 null。真实地区 live 里 damage 为 null 的回复：CC 481 条，CA 2,873 条。

---

## 5. SpacetimeDB 表（`spacetimedb/src/schema.ts`）

### 5.0 约定

- 命名：TS 代码里用 camelCase（`ctx.db.hexStats`、`row.severeLo`）；SQL 里表名和列名都是 snake_case（`hex_stats.severe_lo`，例如 `SELECT * FROM household_estimate WHERE household_id = '...'`）。下面的列名沿用 schema.ts 的写法。
- 列类型：`u8` / `u32` / `u64` 是无符号整数，`f64` 是浮点，`bool`，`string`，`identity`（客户端身份），`timestamp`（真实时间），`scheduleAt`（调度时间），`option(x)`（可空，TS 里是 `undefined`）。
- "PK" = 主键，"autoInc" = 自增，"btree" = 二级索引。单例表的 id 固定为 0（`SINGLETON`）。
- 公开表（`public: true`）客户端可以订阅；私有表只有模块自己能读（owner 也能用 `spacetime sql` 读）。
- 一共 25 张表：公开 19 张、私有 6 张；另有 2 个视图。

### 5.1 公开表：静态世界数据

#### `world`（单例，id = 0）

| 列 | 类型 | 含义 | 数据性质 |
|---|---|---|---|
| `id` | u32 PK | 固定为 0 | – |
| `eventId` | string | `World.eventId` | 合成 |
| `name` | string | `World.name` | 合成 |
| `landfallIso` | string | 登陆时间（ISO） | 合成 |
| `centerLat`, `centerLng` | f64 | `World.center` | 合成 |
| `region` | option(string) | `tx-corpus-christi` / `ca-bay-area` / 空（Harbor Bend） | 元数据 |
| `hazardType` | string | `hurricane` / `earthquake`（bundle 里缺失则为 hurricane） | 元数据 |
| `horizonMinutes` | u32 | 事件时长，缺省 4320 | – |
| `eventLocalHour` | option(u8) | 0–23 | 合成 |
| `eventWeekday` | option(bool) | 是否工作日 | 合成 |
| `dataSourcesJson` | string | 来源/许可字符串组成的 JSON 数组（没有时为 `'[]'`） | 真实（元数据） |
| `localHour` | u8 | 引擎 WorldContext（seed 时算好）：当地小时 | 派生 |
| `weekday` | bool | 是否工作日 | 派生 |
| `daytime` | bool | 工作日 8–18 时：`awayDaytime` 的住户不在家 | 派生 |
| `schoolHours` | bool | 工作日 8–15 时：学龄孩子在学校 | 派生 |
| `timeSource` | string | `world`（用了 eventLocalHour/eventWeekday）或 `landfallIso`（按地区时区从 ISO 时间推算） | 派生 |

#### `facility`

列和 `Facility` 一一对应：`id` string PK，`kind` string，`name` string，`lat`/`lng` f64，`hex` string（btree），`enrollment` option(u32)，`capacity` option(u32)，`source` string。真实数据。

#### `hex`（每格一行）

| 列 | 类型 | 说明 |
|---|---|---|
| `hex` | string PK | `HexCell.hex` |
| `displayOrder` | u32 | 在 bundle `world.hexes` 数组里的下标（seed 脚本写入） |
| `lat`, `lng`, `windMph`, `floodDepthFt`, `towerOutagePct` | f64 | 同 `HexCell` |
| `analystZone` | u8 | 0–2（seed 时校验） |
| `hazardIndex`, `shakingMmi`, `liquefaction` | option(f64) | 同 `HexCell` |
| `tractGeoid` | option(string) | |
| `daytimeWorkers`, `residentWorkers`, `k12Enrollment`, `collegeEnrollment` | option(f64) | |

#### `household`（每户一行；数据是合成的，所以可以公开）

列和 `Household` 一一对应：`id` string PK；`hex` string（btree）；`lat`/`lng` f64；`age65`、`livesAlone`、`medicalDevice`、`windCovered`、`floodPolicy`、`earthquakeEndorsement`、`phoneOnFile` bool；`holdout` bool（btree）；可选列 `tractGeoid` option(string)、`childrenUnder18` option(bool)、`awayDaytime` option(bool)、`age75` option(bool)、`disability` option(bool)、`noVehicle` option(bool)、`limitedEnglish` option(bool)、`primaryLanguage` option(string)、`mobileHome` option(bool)、`policyType` option(string)（`homeowners`/`renters`/`condo`，seed 时校验）、`schoolAgeChildren` option(u8)、`collegeStudent` option(bool)、`nearestSchoolId` option(string)。bundle 里没有的值存为空。

### 5.2 公开表：事件表（只由 `onEvent` 写入）

四张事件表共用下面这些列：

| 列 | 类型 | 含义 | 数据性质 |
|---|---|---|---|
| `id` | u64 PK autoInc | 行 ID；同一分钟内 id 大的算"更晚" | 演示状态 |
| `householdId` | string（btree） | 住户 | |
| `hex` | string（btree） | 住户所在格子 | |
| `t` | u32 | 距登陆分钟（取整，≥ 0）；演示时提交的事件用当前回放分钟 | |
| `source` | string | `replay`（来自 data/live.json）/ `live`（演示时提交）/ `staff_sim`（模拟员工） | 演示状态 |
| `ingestedBy` | identity | 写入者身份（回放和模拟员工是数据库自身） | 演示状态 |
| `ingestedAt` | timestamp | 写入的真实时间 | 演示状态 |

| 表 | 额外列 |
|---|---|
| `sms_sent` | 无 |
| `sms_reply` | `safety` string（`safe`/`needs_help`）；`damage` u8（0–3，`damageKnown` 为 false 时存 0）；`text` option(string)（自由文本，可能不是英文；safety/damage 是它的解析结果）；`language` option(string)（例如 `es`、`zh`）；`damageKnown` bool（false = 回复没描述房子）；`lifeSafety` bool（现在有危险：开一个 911 / 当地机构转介）；`needs` string（逗号分隔：`medical,power_for_device,shelter,water_food,transport,inspection,other`，空串表示没有）；`notHome` bool（回复的人不在房子里，人和房子分开追踪）；`channel` string（`sms` / `call`：坐席打电话联系上） |
| `claim` | `peril` string（注释写的是 `wind`/`flood`，实际也有 `earthquake`）；`reportedDamage` u8 |
| `field_report` | `adjusterId` string（演示时提交的是理赔员的显示名；回放的是 `adj-xx`；模拟员工是 `sim-adjuster`）；`safety` string（`safe`/`needs_help`/`unsure`）；`damage` u8（`damageKnown` 为 false 时存 0）；`damageKnown` bool（false = 只看了人、没评估房子，note 写原因；房子仍未核实，留在查勘队列）；`note` string（≤ 500 字符；回放事件为空串） |

注意：读 `sms_reply.damage` 和 `field_report.damage` 之前一定要先看 `damageKnown`。

### 5.3 公开表：回放、融合输出、"不漏一人"

#### `replay_state`（单例：回放时钟；演示状态）

| 列 | 类型 | 含义 |
|---|---|---|
| `id` | u32 PK | 0 |
| `running` | bool | 是否在走 |
| `simMinutes` | f64 | 当前模拟时间（距登陆分钟） |
| `speed` | f64 | 每真实秒走多少模拟分钟（默认 30，范围 (0, 1440]） |
| `nextSeq` | u32 | 下一个要释放的 staged_event 序号 |
| `totalStaged` | u32 | staged_event 的总数 |
| `maxMinutes` | u32 | 等于 `world.horizonMinutes`（4320 = 72 h） |
| `lastTickAt` | timestamp | 上一次 tick 的真实时间 |
| `fullRecomputeEveryMin` | u32 | 全量重算 + holdout 评分的间隔（模拟分钟；默认 60；0 表示只在跳转/暂停/结束时做） |
| `lastFullRecomputeMin` | f64 | 上一次全量重算时的模拟分钟 |

#### `hex_stats`（每格一行：实时计数 + 融合输出）

| 列 | 类型 | 含义 | 数据性质 |
|---|---|---|---|
| `hex` | string PK | 格子 | |
| `displayOrder` | u32 | 同 `hex.displayOrder` | |
| `households` | u32 | 住户数 | 静态计数 |
| `phones` | u32 | `phoneOnFile` 的住户数 | 静态计数 |
| `smsSent` | u32 | 发过短信的住户数（按户去重） | 演示状态（计数） |
| `smsReplies` | u32 | 用短信回复过的住户数（按户去重，不含电话） | 同上 |
| `replyRate` | f64 | smsReplies / smsSent | 同上 |
| `severeReplies` | u32 | damage ≥ 2 的回复**条数** | 同上 |
| `helpReplies` | u32 | safety = needs_help 的回复**条数** | 同上 |
| `claims` | u32 | 理赔**条数** | 同上 |
| `fieldReports` | u32 | 现场报告**条数** | 同上 |
| `verifiedHouseholds` | u32 | 有评估过房子的现场报告的住户数（去重；只看人的报告不算） | 同上 |
| `severity` | f64 | HexEstimate.severity，0–1 | 模型输出 |
| `confidence` | f64 | 0–1 | 模型输出 |
| `priority` | string | `P0`/`P1`/`P2`（第一次重算之前为 `''`） | 模型输出 |
| `verification` | string | `verified`/`needs_verification`（重算之前为 `''`） | 模型输出 |
| `silence` | f64 | 0–1 | 模型输出 |
| `expectedSevere` | f64 | 预计严重受损的户数 | 模型输出 |
| `severeLo`, `severeHi` | f64 | 严重户数的 90% 区间（engine/src/interval.ts）；stub 估计器下两者都等于 expectedSevere | 模型输出 |
| `severeVar` | f64 | 这个计数的方差（地区总数不用它，见 `metrics.severeTotalLo/Hi`） | 模型输出 |
| `maxPNeedsHelp` | f64 | 0–1 | 模型输出 |
| `hazard` | f64 | 验证规则用的 0–1 灾害分（有 hazardIndex 就用它） | 模型输出 |
| `silenceCause` | string | `away`/`trapped`/`outage`/`unknown`/`''`（不沉默） | 模型输出 |
| `reason` | string | 引擎对 priority/verification 的一句话解释 | 模型输出 |
| `accounted` | u32 | 已联系上的住户数（见 7.1 escalation） | 演示状态 |
| `unaccounted` | u32 | 还没联系上的住户数 | 演示状态 |
| `vulnerable` | u32 | CMIST 脆弱户数（75+、残障、无车、英语有限、医疗设备、65+ 独居） | 静态计数 |
| `unaccountedVulnerable` | u32 | 还没联系上的脆弱户 | 演示状态 |
| `highRiskUnaccounted` | u32 | 没联系上且高风险的户（脆弱、pNeedsHelp ≥ 0.3，或在 P0 格） | 演示状态 |
| `longestWaitMin` | f64 | 高风险户没联系上的最长等待时间（模拟分钟） | 演示状态 |
| `openReferrals` | u32 | 需要帮助或有成员失联、还没解决的转介 | 演示状态 |
| `overdueReferrals` | u32 | 超时的转介（30 分钟内没转介，或转介后 60 分钟内没确认） | 演示状态 |
| `membersMissing` | u32 | 报告有家庭成员失联的住户 | 演示状态 |
| `closedNoContact` | u32 | 没联系上、但以记录在案的原因关闭的住户 | 演示状态 |
| `recheckDue` | u32 | 联系过，但脆弱户最后一次联系已超过 RECHECK_MIN（24 h） | 演示状态 |
| `callContacts` | u32 | 通过坐席电话联系上的住户 | 演示状态 |
| `assistanceRequests` | u32 | 需要帮助但不是生命危险（State Farm 客服） | 演示状态 |
| `inspectionRequests` | u32 | 请求来查勘房子 | 演示状态 |
| `locateDue` | u32 | 房子查勘过、没见到人、也没联系上：需要找人去向 | 演示状态 |
| `updatedAt` | timestamp | 最后写入的真实时间 | |
| `updatedSimMinutes` | f64 | 最后写入时的模拟分钟 | |

#### `household_estimate`（每户一行）

| 列 | 类型 | 含义 |
|---|---|---|
| `householdId` | string PK | |
| `hex` | string（btree） | |
| `pSevere`, `pNeedsHelp`, `uncertainty` | f64 | 见 `HouseholdEstimate` |
| `verified` | bool | 有现场报告 |
| `inspectScore` | f64 | 0–1，越高越应该先派理赔员 |
| `accounted` | bool | 人已联系上（回复、理赔、见到人的现场报告、失联报告、转介、记录在案的关闭） |
| `escalation` | string（btree） | 下一步联系动作，见 7.1 |
| `updatedAt` | timestamp | |

前 6 列是模型输出，`accounted` 和 `escalation` 是演示状态。只有数值变化 ≥ 5e-4（或布尔/字符串变化）时才重写这一行。

#### `inspection_candidate`（主动查勘候选：每格未核实住户里 inspectScore 前 3 名）

只收保单覆盖这次灾种的房子（homeowners / condo / 没有 policyType，且飓风 = windCovered 或 floodPolicy，地震 = earthquakeEndorsement），或已经报了理赔的住户；租户只能通过理赔进来（`src/fusion/coverage.ts`）。不符合的住户照样有估计、跟进和统计，只是不进查勘队列（模拟员工的房屋查勘也因此跳过它们）。

`householdId` string PK；`hex` string（btree）；`rank` u8（1 = 格内最好）；`inspectScore`、`pSevere`、`pNeedsHelp`、`uncertainty` f64；`cellPriority` string；`cellVerification` string；`accounted` bool；`escalation` string。按 inspectScore 排序就得到引擎 `recommendInspections()` 的顺序，不用订阅几万行 household_estimate。

#### `household_followup`（每户跟进状态，"不漏一人"；演示状态）

| 列 | 类型 | 含义 |
|---|---|---|
| `householdId` | string PK | |
| `hex` | string（btree） | |
| `memberMissing` | bool | 报告了有家庭成员失联 |
| `referralStatus` | string | `''` / `referred` / `acknowledged` / `resolved` |
| `referralSimMinutes` | f64 | 转介时的模拟分钟（resolved 时改成解决的时刻） |
| `reportedSimMinutes` | f64 | 报告失联时的模拟分钟（转介计时的起点） |
| `closureReason` | string | `''` / `vacant` / `not_in_area` / `unreachable_after_visit` |
| `closureNote` | string | 关闭说明（有 reason 时必填，≥ 3 字符；模拟员工写 "visited, nobody home; emergency contact unreachable after 3 tries"；重新打开时为 `''`） |
| `closedBy` | string | 关闭人的名字（`owner`、成员名，或模拟员工 `sim-staff`；重新打开时为 `''`） |
| `updatedAt` | timestamp | |

#### `unaccounted_queue`（外联队列：每格还需要联系的前 5 户；演示状态）

| 列 | 类型 | 含义 |
|---|---|---|
| `householdId` | string PK | |
| `hex` | string（btree） | |
| `rank` | u8 | 1 = 格内第一 |
| `weight` | f64 | 风险 × 脆弱 × 格子优先级（分数里和时间无关的部分） |
| `waitSinceMin` | f64 | 开始等待的模拟分钟（外联短信、登陆，或"安全"过期） |
| `escalation` | string | 下一步动作。schema 注释列了 `sms_sent`/`sms_resend`/`agent_call`/`field_visit`/`recheck`，实际也可能是 `locate` |
| `vulnerable` | bool | 是否脆弱户 |
| `cellPriority` | string | 所在格子的 priority |

客户端跨格排序用 `score = weight × (1 + (replay_state.simMinutes − waitSinceMin) / 360)`：每沉默 6 小时，分数就多加一倍权重，所以低风险户也不会一直排不上。`weight = round((max(pNeedsHelp, 0.5·pSevere) + 0.02) × (P0 1.3 / P1 1.1 / P2 1) × (脆弱 1.5，否则 1), 3)`，recheck 再乘 0.5。

#### `staff_sim`（单例：演示用的模拟员工；演示状态）

| 列 | 类型 | 含义 |
|---|---|---|
| `id` | u32 PK | 0 |
| `enabled` | bool | 是否开启（默认开） |
| `callsPerHour` | u32 | 每小时电话数（默认为住户数的 2%，最少 20） |
| `visitsPerHour` | u32 | 每小时上门探视数（默认 0.3%，最少 5） |
| `inspectionsPerHour` | u32 | 每小时房屋查勘数（默认 0.2%，最少 3；查 inspection_candidate 的头部） |
| `lastRunMin` | f64 | 上一次运行的模拟分钟（每 30 分钟一步） |
| `callsMade`, `callsReached` | u32 | 打过的电话 / 接通的电话 |
| `visitsMade` | u32 | 上门次数 |
| `referralsMade`, `referralsResolved` | u32 | 转介次数 / 已解决 |
| `helpFound` | u32 | 通过电话或上门找到的、真正需要帮助的住户 |
| `visitsNobodyHome` | u32 | 查勘了房子但没见到人的上门 |
| `inspectionsMade` | u32 | 房屋查勘次数（和上门探视分开计） |
| `updatedAt` | timestamp | |

模拟员工的结果来自私有的 sim_truth（模拟世界），从不来自模型。

#### `metrics`（单例：全局看板指标）

| 列 | 类型 | 含义 | 数据性质 |
|---|---|---|---|
| `id` | u32 PK | 0 | |
| `hexes`, `households` | u32 | 格子数、住户数 | 静态计数 |
| `smsSent`, `smsReplies` | u32 | 发过短信 / 用短信回复过的住户（去重） | 演示状态 |
| `helpReplies` | u32 | needs_help 回复的条数 | 演示状态 |
| `claims`, `fieldReports` | u32 | 理赔 / 现场报告条数 | 演示状态 |
| `verifiedHouseholds` | u32 | 有评估过房子的现场报告的住户 | 演示状态 |
| `verifiedCoverage` | f64 | verifiedHouseholds / households | 演示状态 |
| `accounted`, `unaccounted` | u32 | 已联系上 / 没联系上的住户（unaccounted 是要降到 0 的数） | 演示状态 |
| `accountedRate` | f64 | accounted / (accounted + unaccounted) | 演示状态 |
| `vulnerable`, `vulnerableAccounted` | u32 | 脆弱户总数 / 已联系上的脆弱户 | 演示状态 |
| `vulnerableAccountedRate` | f64 | 公平性检查：和 accountedRate 对比 | 演示状态 |
| `highRiskUnaccounted` | u32 | 各格之和 | 演示状态 |
| `longestWaitMin` | f64 | 各格的最大值 | 演示状态 |
| `openReferrals`, `overdueReferrals`, `membersMissing`, `closedNoContact`, `recheckDue`, `callContacts`, `assistanceRequests`, `inspectionRequests`, `locateDue` | u32 | 各格之和（含义同 hex_stats） | 演示状态 |
| `expectedSevereTotal` | f64 | 全地区严重户数 = Σ 各格 expectedSevere | 模型输出 |
| `severeTotalLo`, `severeTotalHi` | f64 | 地区总数的范围：各格上下界直接相加（Σ severeLo、Σ severeHi）。同一事件里各格的误差相关，按独立方差相加会过于自信（`spacetimedb/src/fusion/index.ts`，`docs/DATA.md` 第 8 节） | 模型输出 |
| `severeIntervalWidth` | f64 | 各格区间宽度之和 = Σhi − Σlo | 模型输出 |
| `intervalCoverageLive` | f64 | **新增**：区间诚实度检查。在所有有住户的格子里，"90% 严重户数区间包含模拟的真实严重户数（sim_truth 中 damage ≥ 2 的户数）"的格子所占比例，应接近 0.9 | 模型输出对比合成真相 |
| `intervalCellsLive` | u32 | **新增**：参加上面这项检查的格子数（hex_stats.households > 0 的格子） | 演示状态 |
| `p0Cells`, `p1Cells`, `p2Cells` | u32 | 各优先级的格子数 | 模型输出（计数） |
| `needsVerificationCells` | u32 | needs_verification 的格子数 | 模型输出（计数） |
| `holdoutN` | u32 | 参与评分的 holdout 住户数（只算还没核实的；0 表示还没算） | 演示状态 |
| `holdoutBrierSevere` | f64 | holdout 上 (pSevere − [damage ≥ 2])² 的均值 | 模型输出对比真相 |
| `holdoutBrierHelp` | f64 | (pNeedsHelp − [needs_help])² 的均值 | 同上 |
| `holdoutSevereRecall` | f64 | 真严重的 holdout 户里 pSevere ≥ 0.5 的比例 | 同上 |
| `holdoutSimMinutes` | f64 | 上次评分时的模拟分钟 | |
| `trustHazard`, `trustSms`, `trustClaims` | f64 | 当前（学习后的）数据源可信度 | 模型输出 |
| `trustUpdates` | u32 | 可信度已经更新的批次数 | 演示状态 |
| `modelVersion` | u32 | 已加载模型的版本（0 = 没加载） | |
| `engine` | string | 产生这些数字的估计器：`stub` / `engine` | |
| `updatedAt` | timestamp | | |

`intervalCoverageLive` / `intervalCellsLive` 是另一位队友正在加的。在当前工作区里，它们已经出现在 `schema.ts`（第 479–480 行）、`state.ts`（初始值 0）、`ingest.ts` 的 `refreshHoldoutMetrics()` 和 `spacetimedb/bindings/` 中。每次 holdout 重新评分时它们都会更新：`rebuildAll`（reset_demo / recompute_all / load_model / wipe_world）、`refresh_metrics`，以及回放中的全量重算（按 cadence、暂停、跳转、结束时）。因为用到了私有真相，这项检查只在模拟里能做，真实部署时没有。

#### `model_state`（单例：ModelParams JSON + 批量可信度学习状态）

| 列 | 类型 | 含义 |
|---|---|---|
| `id` | u32 PK | 0 |
| `loaded` | bool | 是否加载了模型 |
| `version` | u32 | 模型版本 |
| `paramsJson` | string | 整个 `model.json`（没加载时为 `''`） |
| `baseTrustHazard`, `baseTrustSms`, `baseTrustClaims` | f64 | 校准时测得的可信度（`ModelParams.sourceTrust`） |
| `trustHazard`, `trustSms`, `trustClaims` | f64 | 当前（学习后的）可信度 |
| `trustUpdates` | u32 | 更新的批次数 |
| `lastScoreHazard`, `lastScoreSms`, `lastScoreClaims` | f64 | 上一批里每个数据源的 1 − Brier（−1 表示意见太少，少于 3 条） |
| `pendingFieldReports` | u32 | 等待下一批的非 holdout 现场报告数（TRUST_BATCH = 10） |
| `pendingHazardSse`, `pendingSmsSse`, `pendingClaimsSse` | f64 | 当前批次每个数据源的误差平方和 |
| `pendingHazardN`, `pendingSmsN`, `pendingClaimsN` | u32 | 当前批次每个数据源的意见条数 |
| `holdoutReports` | u32 | holdout 住户上的现场报告数（永远不用于学习） |
| `updatedAt` | timestamp | |

没加载模型时的默认可信度：hazard 0.6、sms 0.7、claims 0.65。每批（10 条非 holdout 现场报告）每个数据源向自己的 1 − Brier 移动 10%，并夹在 [0.3, 1] 之间。可信度默认只用于展示，不影响推断（`cfg.trust.applyToInference = false`）。

#### `member`（演示角色）

`identity` identity PK；`role` string（`manager`/`adjuster`/`policyholder_demo`）；`name` string（1–40 字符）；`joinedAt` timestamp。演示状态。

#### `assignment`（派单）

`id` u64 PK autoInc；`householdId` string（btree）；`hex` string；`adjuster` identity（btree）；`assignedBy` identity；`status` string（`assigned`/`done`/`cancelled`）；`createdAt`、`updatedAt` timestamp。演示状态。被派的理赔员提交这一户的现场报告时，或这户被 `close_household` 关闭时，派单自动变成 `done`。

#### `reply_inbox`（Claude 解析 worker 的输入；演示状态）

`id` u64 PK autoInc；`householdId` string（btree）；`text` string（去空格后 1–500 字符）；`language` string（提示：household.primaryLanguage，没有就是 `''`）；`status` string（btree；`pending` / `parsed` / `failed`）；`receivedAt` timestamp；`parsedAt` option(timestamp)（pending 时为空）；`error` string（`''` = 正常解析；`review: ...` = 解析成功但需要人看；`parser: ...; fallback submitted` = Claude 失败，按"需要人回电"提交；`submit: ...` = reducer 报错）。回复页只写 `submit_raw_reply`，不需要 Anthropic key；`scripts/claude-worker.ts` 订阅 `status = 'pending'` 的行。随演示状态一起清空。

#### 视图（`spacetimedb/src/index.ts`）

| 视图 | 返回 | 含义 |
|---|---|---|
| `my_member` | option(member 行) | 调用者自己的成员行（0 或 1 行） |
| `my_assignments` | assignment 行数组 | 调用者自己的派单（理赔员手机上的任务列表） |

### 5.4 私有表（不可订阅）

#### `config`（单例）

| 列 | 类型 | 含义 |
|---|---|---|
| `id` | u32 PK | 0 |
| `owner` | identity | 模块 owner（`init` 时的发布者），只有它能 seed |
| `staffPasscode` | string | `join_as('manager' \| 'adjuster')` 用的口令 |
| `replyPasscode` | string | `join_as('policyholder_demo')` 用的口令，也用于不加入角色直接提交回复 |
| `worldStamp` | u64 | 最后一次写 hex/household/facility 的微秒时间戳（静态数据缓存的键） |

#### `sim_truth`（每户的 TruthRow；合成）

用于给 holdout 打分、计算 `intervalCoverageLive`，以及决定模拟员工的结果。`householdId` string PK；`damage` u8；`safety` string（`safe`/`needs_help`）；`peril` string（`wind`/`flood`/`earthquake`/`none`）；`needType` string（`life_safety`/`assistance`/`none`；bundle 缺失时 needs_help 记为 life_safety）；`location` string（`home`/`away`/`displaced`；缺失时记为 home）；`returnMin` f64（away 的人回家的模拟分钟，−1 表示不适用或永不回来）。

#### `staged_event`（data/live.json 的全部事件，由回放时钟按 seq 释放；合成）

| 列 | 类型 | 含义 |
|---|---|---|
| `seq` | u32 PK | 0..n−1，和 EventBundle.events 的顺序一致（按 t 排） |
| `t` | u32 | 分钟 |
| `kind` | string | `sms_sent`/`sms_reply`/`claim`/`field_report` |
| `householdId` | string | |
| `safety` | string | 不适用时为 `''` |
| `damage` | u8 | sms_reply / field_report 的 damage |
| `peril` | string | claim 的 peril，否则为 `''` |
| `reportedDamage` | u8 | claim 的 reportedDamage |
| `adjusterId` | string | field_report 的 adjusterId，否则为 `''` |
| `text` | string | sms_reply 的自由文本（没有时为 `''`） |
| `language` | string | 语言代码（没有时为 `''`） |
| `damageKnown` | bool | sms_reply：false 表示没描述房子（此时 damage = 0） |
| `lifeSafety` | bool | sms_reply：现在有危险 |
| `needs` | string | 逗号分隔 |
| `notHome` | bool | 回复的人不在房子里 |
| `channel` | string | `sms`/`call` |

#### `cell_agg`（每格聚合计数器，引擎 `computeRefs` 算世界参考率时用）

`hex` string PK；`outage` f64（0–1，即 towerOutagePct/100）；`daytime` bool；`smsSent`、`replied` u32；`sentEnHome`、`repliedEnHome`、`sentLeHome`、`repliedLeHome`、`sentEnAway`、`repliedEnAway`、`sentLeAway`、`repliedLeAway` u32（按"英语有限 Le / 不是 En" × "现在不在家 Away / 在家 Home"拆开的发送户数和回复户数）；`exposureOwner`、`exposureRenter` f64（Σ hazard × 保险覆盖系数，分自有和租户）；`claimsOwner`、`claimsRenter` u32。每次重算格子时都会写，所以一直是准确的。演示状态（派生）。

#### `replay_tick`（调度表：回放运行时有一行 1 秒间隔的调度）

`scheduledId` u64 PK autoInc；`scheduledAt` scheduleAt。

#### `staff_contact`（模拟员工对每户的电话尝试）

`householdId` string PK；`failedCalls` u8（连续没接的次数，接通后清零）；`lastCallMin` f64；`locateTries` u8（上门没见到人之后联系紧急联系人的次数）。

### 5.5 Reducer 参数类型（不是表）

| 类型 | 字段 | 用于 |
|---|---|---|
| `WorldInput` | `eventId`、`name`、`landfallIso` string；`centerLat`、`centerLng` f64；`region` option(string)；`hazardType` option(string)；`horizonMinutes` option(u32)；`eventLocalHour` option(u8)；`eventWeekday` option(bool)；`dataSources` array(string) | `seed_world` |
| `HexInput` | 和 `hex` 表的列完全相同 | `seed_hexes` |
| `FacilityInput` | 和 `facility` 表的列完全相同 | `seed_facilities` |
| `HouseholdInput` | 和 `household` 表的列完全相同 | `seed_households` |
| `TruthInput` | 和 `sim_truth` 表的列完全相同 | `seed_truth` |
| `StagedEventInput` | 和 `staged_event` 表的列完全相同 | `seed_staged_events` |

---

## 6. Reducers

"owner" 指模块发布者的身份（不是角色）；"manager 检查"指 manager 成员或 owner 都可以；口令见 `config`。

### 6.1 生命周期

| 名称 | 触发 | 作用 |
|---|---|---|
| `init` | 第一次发布（或用 `--delete-data` 重新发布） | 发布者成为 owner，写 config（口令为空），创建 replay_state / metrics / model_state 单例 |
| `onConnect` / `onDisconnect` | 客户端连接 / 断开 | 什么都不做 |

### 6.2 Seed 与维护（`reducers/seed.ts`）

| Reducer | 参数 | 谁可以调 | 作用 |
|---|---|---|---|
| `set_passcodes` | `staffPasscode: string, replyPasscode: string` | owner | 设置演示口令（每个至少 4 个字符） |
| `seed_world` | `world: WorldInput` | owner | 写入或更新 world，算好引擎 WorldContext（localHour、daytime、schoolHours），把 replay_state.maxMinutes 设为 horizon |
| `seed_facilities` | `facilities: FacilityInput[]` | owner | 写入或更新设施（校验 kind），更新 worldStamp |
| `seed_hexes` | `hexes: HexInput[]` | owner | 写入或更新格子（analystZone ≤ 2），同时建空的 hex_stats 行 |
| `seed_households` | `households: HouseholdInput[]` | owner | 写入或更新住户（hex 必须已存在；校验 policyType） |
| `seed_truth` | `rows: TruthInput[]` | owner | 写入私有 sim_truth（校验 damage、safety、needType、location） |
| `seed_staged_events` | `events: StagedEventInput[]` | owner | 写入私有 staged_event（校验 kind、safety、peril、damage、channel、needs），更新 totalStaged |
| `load_model` | `json: string` | owner | 校验并保存 ModelParams；region/hazardType 和世界不符就拒绝；可信度重置为 sourceTrust；已有格子时全量重建 |
| `reset_demo` | 无 | manager 检查 | 清空所有事件、估计、派单、跟进、队列和模拟员工计数，回到 t = 0，全量重算（成员和 cadence 保留） |
| `recompute_all` | 无 | manager 检查 | 从事件表重新数所有计数器，并重算所有格子（修复工具） |
| `refresh_metrics` | 无 | manager 检查 | 立即重算 holdout 指标和 intervalCoverageLive |
| `wipe_world` | 无 | owner | 删除整个世界（world、设施、格子、住户、真相、staged、统计、cell_agg）和演示状态 |

### 6.3 回放（`reducers/replay.ts`）

| Reducer | 参数 | 谁可以调 | 作用 |
|---|---|---|---|
| `replay_tick` | `arg: replay_tick 行` | 只有调度器（数据库自身的身份） | 每秒一次：时钟前进 speed × 经过的秒数（最多按 5 秒算），释放到期事件，运行模拟员工，按 cadence 全量重算，到终点就停 |
| `step_replay` | `minutes: f64`（(0, 1440]） | manager 检查 | 像一次 tick 一样前进 minutes（暂停时也能用） |
| `start_replay` | `speed: f64`（(0, 1440]） | manager 检查 | 开始或继续回放（插入调度行），同时设置速度；已经播完的要先 reset |
| `pause_replay` | 无 | manager 检查 | 停止调度并全量重算（暂停后的地图和引擎结果完全一致） |
| `jump_to` | `minutes: f64`（[0, maxMinutes]） | manager 检查 | 向前跳：一次释放所有到期事件（模拟员工开着时按 30 分钟一步走）；向后跳：先重置演示，再重播到 minutes。最后总会全量重算 |
| `set_speed` | `speed: f64` | manager 检查 | 只改速度 |
| `set_recompute_cadence` | `minutes: u32`（[0, 4320]） | manager 检查 | 设置运行中的全量重算间隔 |
| `set_staff_sim` | `enabled: bool, callsPerHour: u32, visitsPerHour: u32, inspectionsPerHour: u32` | manager 检查 | 开关模拟员工并设置容量（0 = 默认值，上限 100,000），从当前模拟时间开始生效 |

### 6.4 人员、提交、派单、跟进（`reducers/people.ts`）

| Reducer | 参数 | 谁可以调 | 作用 |
|---|---|---|---|
| `join_as` | `role: string, name: string, passcode: string` | 任何人：manager/adjuster 要 staff 口令，policyholder_demo 用 reply 或 staff 口令；owner 不需要口令 | 创建或替换调用者的 member 行（可以换角色） |
| `leave` | 无 | 任何人 | 删除自己的 member 行 |
| `remove_member` | `identityHex: string` | manager 检查 | 删除一个成员（他没完成的派单保留） |
| `submit_sms_reply` | `householdId, safety, damage: u8, passcode` | policyholder_demo / manager 成员、owner，或持有 reply/staff 口令的任何人 | 按钮回复：在当前模拟分钟插入 sms_reply（channel `sms`，`lifeSafety = (safety == needs_help)`，needs 为空，notHome false）；这户从没发过短信的话补一条 sms_sent；重算格子 |
| `submit_sms_text_reply` | `householdId, safety, damage: u8, text, language, passcode` | 同上 | 同上，另外保存原始文本（≤ 1000 字符）和语言（≤ 16 字符） |
| `submit_parsed_reply` | `householdId, safety, damage: u8, lifeSafety: bool, needs: string, notHome: bool, text, language, passcode` | 同上 | Claude（或其他解析器）的完整结构化结果；damage 255 表示回复没描述房子；needs 逗号分隔。Claude worker（`scripts/claude-worker.ts`）用 manager 身份调用，见 docs/CLAUDE_PARSER.md |
| `submit_field_report` | `householdId, safety, damage: u8, note, memberMissing: bool` | **只有 adjuster 成员**（owner 没以 adjuster 加入也不行） | 插入 field_report（safety 为 `safe`/`needs_help`/`unsure`，note ≤ 500）；damage 0–3 = 房子评估结果：这户变为已核实，邻居做残差更新，非 holdout 的报告进入可信度批次；**damage 255 = 没评估房子**（不安全、进不去、太黑）：note 必填（≥ 3 字符，否则报错），safety 照样记录住户状态，房子仍未核实、留在查勘队列，不进可信度批次；memberMissing true = 现场发现有人失联（同 report_member_missing，保留已开的转介）；完成自己对这户的派单 |
| `assign` | `householdId, adjusterIdentityHex` | manager 检查 | 把一户派给一个 adjuster 成员，并取消其他人对这户没完成的派单 |
| `assign_hex` | `hex, adjusterIdentityHex, count: u32` | manager 检查 | 主动查勘：把这一格里未核实、未派单、inspectScore 最高的 count 户（1–50）派给他 |
| `update_assignment` | `id: u64, status: string` | 被派的 adjuster 本人，或 manager 检查 | 把状态改成 `assigned`/`done`/`cancelled` |
| `report_member_missing` | `householdId, passcode` | 同 submit_sms_reply | "家里有人失联"：设 memberMissing，记录时刻，开始转介计时（已经开着的转介保留） |
| `update_referral` | `householdId, status: string` | manager 检查 | 转介流程 `referred` → `acknowledged` → `resolved` |
| `close_household` | `householdId, reason: string, note: string` | manager 或 adjuster 成员，或 owner | 以记录在案的原因关闭（`vacant`/`not_in_area`/`unreachable_after_visit`）；有 reason 时 note 必填（≥ 3 字符），存进 `closureNote`；`unreachable_after_visit` 要求这户已有一条 safety `unsure` 的 field_report（上门没见到人）；关闭时把这户 `assigned` 的派单改成 `done`；`''` 表示重新打开（清空 note，不动派单） |
| `submit_raw_reply` | `householdId, text, passcode` | 同 submit_sms_reply | 把原始自由文本（去空格后 1–500 字符）放进 `reply_inbox`（status `pending`，language 取 household.primaryLanguage），由 Claude 解析 worker 处理；每户最多 5 条、全库最多 500 条待处理 |
| `mark_reply_parsed` | `id: u64, status: string, error: string` | manager 检查 | worker 用：`parsed` / `failed`（写 parsedAt），`pending` = 重新排队；error 截到 500 字符 |

补充说明：
- 代码里三个回复 reducer 都把 damage 255 当作"未知"（文档只对 submit_parsed_reply 写明了）。
- 所有提交都走 `ingest.ts` 的 `onEvent()`，`source = 'live'`。
- 模拟员工不是 reducer。它在回放时钟里直接调用 `onEvent()`，`source = 'staff_sim'`：接通的电话是 channel `call` 的 sms_reply，上门和查勘是 `sim-adjuster` 的 field_report。

---

## 7. 枚举值（以字符串存储）

### 7.1 `escalation`（`spacetimedb/src/fusion/index.ts` 的 `ESCALATION`）

"accounted"一列说明处于这个状态时人是否算"已联系上"。

| 值 | accounted | 含义 / 触发条件 |
|---|---|---|
| `sms_sent` | 否 | 还没联系上，阶梯第 0 步（等外联短信的回复） |
| `sms_resend` | 否 | 重发短信：高风险户在发出后 30 min，标准户 2 h |
| `agent_call` | 否 | 坐席打电话：高风险 90 min，标准 6 h；没登记手机号的户直接从这一步开始（通过代理人或紧急联系人） |
| `field_visit` | 否 | 上门：高风险 4 h，标准 12 h；P2 格里 pNeedsHelp < 0.2 的低风险户是 48 h（但一定会上门） |
| `locate` | 否 | 理赔员查勘了房子但没见到人（现场 safety 为 `unsure`）：通过紧急联系人、避难所名单找人，直到联系上或以 `unreachable_after_visit` 关闭 |
| `recheck` | 是 | 脆弱户最后一次联系已超过 24 h（RECHECK_MIN = 1440）："安全"过期，回到队列（权重乘 0.5） |
| `emergency_referral` | 是 | 生命安全报告（回复 lifeSafety、理赔员发现需要帮助，或成员失联），等待转介 |
| `referral_pending` | 是 | 已经转介（`referred`），等待机构确认 |
| `referral_overdue` | 是 | 超时：报告后 30 min（REFER_MIN）内没转介，或转介后 60 min（REFERRAL_ACK_MIN）内没确认 |
| `referral_acknowledged` | 是 | 机构已确认 |
| `assistance` | 是 | 回复说需要帮助但不是生命危险（住处、供电、药品、交通），由 State Farm 客服跟进 |
| `inspection_request` | 是 | 回复请求有人来看房子 |
| `accounted` | 是 | 联系上了，没有危险 |
| `verified` | 是 | 理赔员在现场见到了住户（safety 不是 `unsure`） |
| `closed` | 是 | 有记录在案的关闭原因 |

"高风险" = 脆弱户、pNeedsHelp ≥ 0.3，或所在格子是 P0。阶梯（`sms_sent → sms_resend → agent_call → field_visit → locate`）只进不退，即使风险估计后来降低了也一样。

### 7.2 其他枚举

| 枚举 | 值 | 用在哪里 / 说明 |
|---|---|---|
| `priority` | `P0` / `P1` / `P2`（hex_stats 第一次重算之前为 `''`） | hex_stats、inspection_candidate.cellPriority、unaccounted_queue.cellPriority；规则见 8.2 |
| `verification` | `verified` / `needs_verification`（重算之前为 `''`） | hex_stats、inspection_candidate.cellVerification |
| `silenceCause` | `away` / `trapped` / `outage` / `unknown` / `''`（不沉默） | hex_stats；规则见 8.2 |
| `referralStatus` | `''` / `referred` / `acknowledged` / `resolved` | household_followup |
| `closureReason` | `''` / `vacant` / `not_in_area` / `unreachable_after_visit` | household_followup；有 reason 必须有 closureNote；最后一个要求这户有 safety `unsure` 的现场报告 |
| `channel` | `sms` / `call` | sms_reply、staged_event；`call` = 坐席电话（目前只有模拟员工会产生） |
| `source` | `replay` / `live` / `staff_sim` | 四张事件表 |
| 角色 `role` | `manager` / `adjuster` / `policyholder_demo` | member；owner 是一个身份，不是角色 |
| `needs`（`Need`） | `medical`（药品/医疗）、`power_for_device`（医疗设备需要供电）、`shelter`（住处）、`water_food`（水和食物）、`transport`（交通、没车）、`inspection`（来看房子，对应 `inspection_request`）、`other` | sms_reply.needs（逗号分隔），`ingest.ts` 的 `NEEDS` 常量 |
| `Damage` | 0 / 1 / 2 / 3 | 无损 / 轻微 / 严重 / 无法居住 |
| `Safety` | `safe` / `needs_help` / `unsure` | 回复只用前两个；现场报告三个都可以 |
| `Peril` | `wind` / `flood` / `earthquake`（truth 里还有 `none`） | claim、sim_truth |
| `HazardType` | `hurricane` / `earthquake` | world |
| `NeedType` | `life_safety` / `assistance` / `none` | sim_truth |
| `Whereabouts`（`location`） | `home` / `away` / `displaced` | sim_truth |
| 事件 `kind` | `sms_sent` / `sms_reply` / `claim` / `field_report` | staged_event、SimEvent |
| `Facility.kind` | `school` / `university` / `hospital` / `shelter` / `fire_station` / `mast` | facility |
| `policyType` | `homeowners` / `renters` / `condo` | household |
| `primaryLanguage` | `en` 英语、`es` 西班牙语、`zh` 中文、`vi` 越南语、`tl` 他加禄语、`ko` 韩语、`fr` 法语、`de` 德语、`ru` 俄语、`ar` 阿拉伯语、`other-ie` 其他印欧语、`other-api` 其他亚太语言、`other` 其他 | household；回复模板只有 en/es/zh/vi/tl/ko，其他语言回退到英文 |
| `assignment.status` | `assigned` / `done` / `cancelled` | assignment |
| `metrics.engine` | `stub` / `engine` | 没加载有效模型时用临时的规则估计器 `stub` |
| `world.timeSource` | `world` / `landfallIso` | world |
| `adjusterId` 约定 | HB 回测 `adj-01`…`adj-10`（Bay Area backtest-1 里有 20 个）；模拟员工 `sim-adjuster`；演示时提交的是理赔员的成员名 | field_report |
| `closedBy` 约定 | 成员名、`owner`、模拟员工 `sim-staff` | household_followup |

---

## 8. 模型输出与区间

下面的默认参数都来自 `engine/src/config.ts` 的 `DEFAULT_CONFIG`。

### 8.1 每户

- **`pSevere`**：P(damage ≥ 2)。逻辑回归 `sigmoid(severe.bias + Σ weights·x)`，x 是这户在当前快照下的 45 个特征（灾害/地图、住户静态属性、自己的短信和理赔信号、同格其他住户的聚合，见附录 A.4）。格子里有 k 户现场报告时，未核实户再做一次邻居残差更新：`logit += 2 × Σ(y_j − p̂_j) / (k + 2)`。已核实户直接用现场结果：damage ≥ 2 记 0.98，否则 0.02。
- **`pNeedsHelp`**：P(safety = needs_help)。用同样 45 个特征和 `needsHelp` 那组权重，同样做邻居更新（只用 safety 不是 `unsure` 的报告）。已核实户：needs_help 记 0.98，safe 记 0.02，unsure 保留模型值。
- **`uncertainty`**：0–1，越大越拿不准。未核实户 = `clamp01(0.6 × 2√(p(1−p)) + 0.4 × (1 − evidenceScore))`，其中 p = pSevere，`evidenceScore = max(自己回复过或理赔过 ? 1 : 0, clamp01(同格其他户被联系上的比例 / 0.5))`。已核实户为 0.02（现场 safety 为 `unsure` 时 0.1）。
- **`inspectScore`**：主动查勘推荐分 = `(1·pSevere + 1·pNeedsHelp + 0.8·uncertainty + 0.5·格子 silence + 0.2·[格子 needs_verification]) / 3.5`；已核实户为 0。

### 8.2 每格

- **`hazard`**：有 `hazardIndex` 就用它；没有时（Harbor Bend）= `0.75 × max(windNorm, floodNorm) + 0.25 × analystZone/2`，其中 `windNorm = clamp((wind − 50)/80)`，`floodNorm = 1 − exp(−depth/2)`。
- **`expectedSevere`**：格内所有住户的 pSevere 之和（已核实户贡献 0.98 或 0.02）。
- **`severity`**：`1 − (1 − expectedSevere/households) × (1 − maxPNeedsHelp)`。意思是"严重受损比例高"和"有一户很可能需要帮助"只要有一个成立，严重程度就高。
- **`confidence`**：`(0.5 × coverageScore + 0.5 × (1 − meanSpread)) × (1 − 0.5 × outage × (1 − coverageScore))`。coverageScore = 被联系上（回复/理赔/现场报告）的住户比例 ÷ (0.15 + 0.35 × hazard)，最大为 1；meanSpread = 未核实户 4p(1−p) 的平均（已核实户计 0）；outage = towerOutagePct/100。也就是说：证据覆盖够不够（灾害越大要求越高）乘以估计是否果断，停电造成的缺口再扣一些分。`confidence` 是格子级的，`uncertainty` 是住户级的，两者不是简单的互补关系。
- **`silence`**：`clamp01(hazard × max(0, 1 − heardFrom/expectedHeard) × (1 − exp(−expectedHeard)))`。expectedHeard 是按世界参考率算出的"本该听到多少户"：参考回复率取自低停电（≤ 20%）格子里说英语、在家的住户，再按英语有限、白天不在家的系数调整；预期理赔按投保暴露（自有/租户）计算。预期信号很少时，沉默说明不了什么，所以最后乘一个衰减项。
- **`silenceCause`**：silence < 0.2 时不设。outage ≥ 0.5 → `outage`。否则看沉默的住户里谁占多数：白天事件、"不在家"的人占沉默户 ≥ 50% 且比全格比例高 1.2 倍 → `away`；CMIST 脆弱户（引擎的定义：75+、残障、无车、医疗设备、独居）满足同样条件 → `trapped`；两个都满足时取过度代表程度更高的那个；都不满足 → `unknown`。
- **`priority`**：maxPNeedsHelp ≥ 0.5 或 expectedSevere/households ≥ 0.5 → P0；≥ 0.25 或 ≥ 0.2 → P1；否则 P2。高灾害（hazard ≥ 0.5）且 silence ≥ 0.5 的格子至少提到 P0（"suspected P0"）。
- **`verification`**：confidence < 0.5，或者高灾害且沉默 → `needs_verification`；否则 `verified`。
- **`reason`**：把上面的判断拼成一句英文：分级原因、沉默情况、已核实户数、confidence，上课时间还会加学生提示。

### 8.3 严重户数区间：`severeLo` / `severeHi` / `severeVar`（`engine/src/interval.ts`）

1. **精确部分**：格内未核实住户的严重户数 S = Σ Bernoulli(p_i)（p_i 是邻居更新后的 pSevere）。它的精确分布是 Poisson-binomial，用动态规划算（格子只有几十户）。取两侧尾概率各为 `tail` 的分位数 [q_lo, q_hi]。
2. **为共享误差放宽**：同一格的住户有共同的误差（例如整格的灾害估计偏了），所以并不完全独立。共享方差 `shared = τ² × μ² × 2/(2 + k)`，τ² = `ModelParams.cellOverdispersion`（缺省 0.1），μ = Σp_i，k = 格内有现场报告的户数（报告越多，共享误差越小）。放宽系数 `w = √(1 + shared / Σp(1−p))`；每一侧按它到均值的距离乘以 (w − 1) 往外扩，四舍五入到整户。所有 p 都是 0 或 1 时，退化为正态近似。
3. **已核实户**：pSevere ≥ 0.5 的算已知的严重户，只平移区间，不贡献方差。结果先截到 [0, 未核实户数]，再加上已知严重户数。
4. **`severeVar`** = Σp(1−p) + shared。数据库把它存在 `hex_stats`；全地区的总数（`metrics.severeTotalLo/Hi`，见 5.3）不用它，而是把各格上下界直接相加。

**尾概率的校准**（`engine/scripts/calibrate.ts`）：
- τ² 用矩估计：`Σ((y − μ)² − Σp(1−p)) / Σμ²`，下限为 0。数据是留出事件在各个快照时间（6/12/24/48 h）上的每个格子，k = 0。
- 线上用的 `cellIntervalTail` 是保守的 **0.05**（两侧各 5%，标准 90% 区间）：留一事件覆盖率 0.968 / 0.976 / 0.954，平均宽度 1.64 / 2.44 / 4.87 户。
- 校准脚本还会算一个更窄的 tail（从 0.05 … 0.20 里选留一覆盖率仍 ≥ 90% 的最大值：0.16 / 0.16 / 0.10，嵌套检验覆盖率 0.904 / 0.902 / 0.908，宽度 0.97 / 1.32 / 3.84 户），但它在更难的实时事件上过度自信（湾区开局只覆盖 67%），所以只打印作参考，不上线。见 docs/DATA.md 第 8 节。
- 注意：tail = 0.16 **不代表**名义上的 68% 区间。计数是离散的，很多格子的分布集中在 0–2 户，精确分位数的实际覆盖率远高于 1 − 2·tail（tail = 0.05 时实测是 94–97%）。所以 tail 只是一个调节旋钮，真正的保证是在回测上测出来的约 90% 经验覆盖率。
- 演示时，`metrics.intervalCoverageLive` 在 live 事件上用模拟真相再检查一次。
- 没加载模型时（stub 估计器），severeLo = severeHi = expectedSevere，severeVar = 0。

### 8.4 校准指标与 holdout

- `ModelParams.calibration` 里的指标都是留一事件的均值，含义见 3.9。
- `metrics.holdout*`：在 live 世界里，用私有真相给**还没核实**的 holdout 住户打分（已核实的户是已知值，不是预测）。这些住户永远不参与训练，也不参与可信度学习。

---

## 附录 A：内部类型（不在 shared/types.ts 里，但会用到）

### A.1 `IngestEvent` 和 `Source`（`spacetimedb/src/ingest.ts`）

`IngestEvent` 和 `SimEvent` 一样按 `kind` 区分。区别是：`sms_reply` 的 `lifeSafety: boolean`、`needs: string[]`、`notHome: boolean`、`channel: 'sms' | 'call'` 都是必填；`field_report` 多一个 `note: string`（`damage: Damage | null`，null = 没评估房子）。`Source = 'replay' | 'live' | 'staff_sim'`。

### A.2 Fusion 适配层（`spacetimedb/src/fusion/types.ts`）

| 类型 | 字段 | 用途 |
|---|---|---|
| `SourceTrust` | `hazard, sms, claims: number` | 当前可信度 |
| `HouseholdSignals` | `household`；`smsSentT`（第一次发短信的时间，或 null）；`reply`（最新一条回复：t、safety、damage 或 null、lifeSafety、needs、notHome、channel；没有则为 null）；`claim`（t、peril、reportedDamage）；`field`（t、safety、damage、adjusterId） | 当前模拟时间下一户的全部已知信号（每类取最新一条） |
| `CellInput` | `cell, households, facilities, nowMin, world, trust, params` | 估计器的输入 |
| `RefsCounters` | 和 `cell_agg` 的列相同 | 世界参考率的计数器 |
| `HouseholdOutput` | `HouseholdEstimate` 加上必填的 `inspectScore` | |
| `CellOutput` | `households: HouseholdOutput[]`，`hex: HexEstimate`，`severeVar?` | 一格的估计结果 |
| `CellEstimator` | `name: 'stub' \| 'engine'`、`needsRefs`、`prepare`、`refsCounters`、`estimate` | 可插拔的估计器（三个阶段：聚合 → 世界参考率 → 估计） |

### A.3 引擎上下文（`engine/src/features.ts`）

- `WorldContext`：`hazardType, horizonMinutes, localHour, weekday, daytime, schoolHours, timeSource`（数据库的 world 表存了一份）。
- `WorldRefs`：`refReplyRate, limitedEnglishReplyFactor, awayReplyFactor, claimRatePerExposure, renterClaimFactor`。
- `CellAggregate`：每格的去重计数，包括 heardFrom、silent、silentAway、silentVulnerable、expectedReplies/Claims/Heard 等。数据库只持久化参考率需要的那部分（`cell_agg`）。

### A.4 45 个特征（`ModelParams.features` 的顺序）

| 来源组 | 特征 |
|---|---|
| hazard | `windNorm`, `floodNorm`, `hazardIndex`, `liquefaction`, `outage`, `analystZone`, `floodNoPolicy`, `uncoveredHazard`, `mobileHomeHazard` |
| static | `age65`, `livesAlone`, `medicalDevice`, `age65Alone`, `medicalDeviceOutage`, `age75`, `disability`, `noVehicle`, `limitedEnglish`, `mobileHome`, `childrenUnder18`, `awayDaytime`, `awayNow`, `renter`, `collegeStudent`, `schoolAgeChildren`, `schoolHours`, `schoolHoursChildren`, `timeNorm` |
| sms（自己） | `smsReplied`, `smsReplyDamage`, `smsReplyDamageUnknown`, `smsReplyNeedsHelp`, `smsNoReply`, `smsNoReplyOutage`, `smsNoReplyLowOutageTime`, `smsNoReplyLimitedEnglish`, `smsNoReplyAway` |
| sms（同格其他户） | `cellSevereReplyShare`, `cellHelpReplyShare`, `cellReplyRate` |
| claims（自己） | `claimFiled`, `claimDamage` |
| claims（同格其他户） | `cellClaimRate`, `cellClaimLogRatio`, `cellClaimSevereShare` |

邻居的现场报告故意没有做成特征：回测里的现场报告是随机抽的，实时演示里的是主动查勘挑出来的，学到的权重会高估它们。所以它们通过 8.1 里的残差更新进入模型。

---

## 附录 B：不一致或不清楚的地方

1. （已修正）`data/README.md` 的回测表原来只列到 `backtest-6`，现在列全 10 个（`data/model.json` 的 `trainedOn` 也是 10 个）。
2. `schema.ts` 里 `claim.peril` 的注释写 `'wind' | 'flood'`，但 Bay Area 的理赔是 `earthquake`，`seed_staged_events` 也接受 `earthquake`。
3. `metrics.accounted` 的注释写 "reply, claim or field report"。实际规则（`accountFor`）还包括失联报告、进行中的转介和记录在案的关闭；而 safety 为 `unsure` 的现场报告不算人已联系上。
4. `hex_stats.claims`、`fieldReports`、`severeReplies`、`helpReplies` 是**条数**，而 `HexEstimate.counts` 是按户去重的数；数据库没有单独存 `HexEstimate.counts`。
5. `rebuildAll()`（recompute_all、load_model、wipe_world 会调用）把 channel `call` 的回复也算进 `smsReplies`，并且不重数 `callContacts`（会变成 0）；而 `onEvent()` 把电话排除在 smsReplies 之外。回放进行到一半时调 recompute_all，这两个数可能和增量计数对不上（reset_demo 会先清空事件，不受影响）。
6. "脆弱户"有两个定义：数据库的 `isVulnerable` = 75+、残障、无车、英语有限、医疗设备、65+ 且独居；引擎（用于 `silenceCause = trapped`）= 75+、残障、无车、医疗设备、任何独居（不含英语有限）。
7. `docs/SPACETIME_API.md` 说有 44 个特征，但 `FEATURE_NAMES` 和三个 model.json 都是 45 个。
8. `Facility.capacity` 在类型和表里都有，但现有数据文件从来没填过。
9. `data/model.json` 的 `region` 是 `harbor-bend`，而 Harbor Bend 的 world 没有 region；`load_model` 只在两边都有 region 时才比较，所以仍能加载。
10. 没有任何 bundle 设置 `World.horizonMinutes`，全部按缺省值 4320。
11. `TruthRow.returnMin` 只出现在 Bay Area live 的 `away` 行；其他文件里没有这个字段（数据库存 −1）。
12. `ModelParams.calibration.baseline` 的类型注释写"只看灾害强度"，代码实际用的是 hazard + static 两组特征。
13. CDC SVI 在 `dataSources` 里只给了署名要求，没说是否属于公有领域。
14. （已修正）Bay Area live 的发生时间：`docs/SPACETIME_API.md` 原来写 "Thu 10:00"，现在和 `data/real/README.md` 一致，都是周五 10:40。bundle 里 `landfallIso = 2026-11-06T18:40:00.000Z`（按 PST 换算是周五 10:40），`eventLocalHour = 10`，`eventWeekday = true`。

## 附：短信送达回执（v3 增量）

- `sms_sent.delivered`（bool）与 `staged_event.delivered`：运营商送达回执，false = 手机关机 / 没电 / 丢失 / 没信号。事件数据 `sms_sent.delivered` 可缺省，缺省视为已送达。
- `hex_stats` / `metrics` 新增 `undeliveredUnaccounted`（未联系且短信未送达）、`deliveredNoReply`（未联系但短信已送达）。
- 联系梯子：未送达 → 直接 `agent_call`（紧急联系人），按高风险时限上门；已送达但不回的高风险户 3 小时上门（`DELIVERED_SILENT_VISIT_MIN`）。
