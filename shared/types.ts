// Triage Loop：所有模块共用的数据契约（模拟器、引擎、Spacetime 模块、前端）。
// 改这里之前先告诉队友，因为四个模块都依赖它。
// 本项目的全部数据都是合成的，不含任何真实客户信息。

export type HexId = string;      // H3 索引，分辨率 8（每格约 0.7 平方公里）
export type Minutes = number;    // 距飓风登陆的分钟数
export type Damage = 0 | 1 | 2 | 3; // 0 无损，1 轻微，2 严重，3 无法居住
export type Safety = 'safe' | 'needs_help' | 'unsure';
export type Priority = 'P0' | 'P1' | 'P2';                    // 需要多快采取行动
export type Verification = 'verified' | 'needs_verification';  // 信息够不够
export type Peril = 'wind' | 'flood' | 'earthquake';
export type HazardType = 'hurricane' | 'earthquake';

export interface HexCell {
  hex: HexId;
  lat: number;
  lng: number;
  windMph: number;         // 峰值风速（地震场景为 0）
  floodDepthFt: number;    // 洪水深度，0 表示没淹（地震场景为 0）
  towerOutagePct: number;  // 0–100，基站中断比例
  analystZone: 0 | 1 | 2;  // 人工标注的受灾区：0 无，1 中度，2 严重
  // v2 可选字段：真实地图版数据才有，旧数据没有也合法
  hazardIndex?: number;     // 0–1，不分灾种的强度，引擎优先用它
  shakingMmi?: number;      // 地震：修正麦加利烈度
  liquefaction?: number;    // 地震：0–1 液化易发程度
  tractGeoid?: string;      // 重叠最多的人口普查区
  daytimeWorkers?: number;  // LODES：在这个格子里上班的人数
  residentWorkers?: number; // LODES：住在这个格子里的在职人数
  k12Enrollment?: number;   // 这个格子里中小学的在校学生总数（NCES）
  collegeEnrollment?: number; // 这个格子里大学的在校学生总数
}

// v2：真实设施（学校常作为避难所）
export interface Facility {
  id: string;
  kind: 'school' | 'university' | 'hospital' | 'shelter' | 'fire_station' | 'mast';
  name: string;
  lat: number;
  lng: number;
  hex: HexId;
  enrollment?: number;
  capacity?: number;
  source: string;           // 数据来源，例如 "NCES" 或 "OpenStreetMap"
}

export interface Household {
  id: string;
  hex: HexId;
  lat: number;
  lng: number;
  age65: boolean;
  livesAlone: boolean;
  medicalDevice: boolean;          // 客户自己提供、同意使用的信息
  windCovered: boolean;            // 房屋险通常保风灾
  floodPolicy: boolean;            // 洪水要单独的洪水险
  earthquakeEndorsement: boolean;  // 地震要单独的附加险（飓风场景里只做展示）
  phoneOnFile: boolean;            // 有登记手机号才会收到短信
  holdout: boolean;                // true：只用来评估，永远不参与训练
  // v2 可选字段
  tractGeoid?: string;             // 所属人口普查区
  childrenUnder18?: boolean;       // 家里有 18 岁以下孩子
  awayDaytime?: boolean;           // 白天通常不在家（通勤上班等）
  // v2 功能需求（CMIST），按普查区真实比例抽样，个体是合成的
  age75?: boolean;                 // 75 岁以上（卡特里娜死亡风险最高的年龄段）
  disability?: boolean;            // 残障或行动不便
  noVehicle?: boolean;             // 家里没有车，难以撤离
  limitedEnglish?: boolean;        // 英语能力有限
  primaryLanguage?: string;        // 外联短信用的语言，也是自由文本回复的语言。代码：en es zh vi tl ko fr de ru ar other-ie other-api other
  mobileHome?: boolean;            // 住移动房屋，风灾下最脆弱
  // v2 学生与住房（按普查区真实比例抽样）
  policyType?: 'homeowners' | 'renters' | 'condo'; // 租户只保财物和临时住宿，房屋结构由房东的保险负责
  schoolAgeChildren?: number;      // 5–17 岁孩子人数
  collegeStudent?: boolean;        // 大学生住户（常为租户、无车、离家）
  nearestSchoolId?: string;        // 最近学校的 Facility.id，用于家庭团聚信息和避难所转介
}

// v3：灾害本身的几何信息，给地图画登陆点 / 路径 / 震中 / 破裂线
export type HazardGeometry =
  | { kind: 'hurricane'; landfall: { lat: number; lng: number }; track: { lat: number; lng: number }[]; headingDeg: number; vmaxMph: number; category: number; rmaxKm: number;
      // 预计影响范围：沿路径的风圈带（闭合多边形），hurricane = 飓风级风（≥74 mph），tropical = 热带风暴级风（≥39 mph）；radiiKm 是登陆时的半径
      swath: { hurricane: { lat: number; lng: number }[]; tropical: { lat: number; lng: number }[]; radiiKm: { hurricane: number; tropical: number } } }
  | { kind: 'earthquake'; epicenter: { lat: number; lng: number }; rupture: [{ lat: number; lng: number }, { lat: number; lng: number }] | null; magnitude: number; faultName: string };

export interface World {
  eventId: string;          // 例如 "live" 或 "backtest-1"
  name: string;             // 虚构地名，例如 "Harbor Bend, TX"
  landfallIso: string;      // 登陆时间（ISO 字符串）
  center: { lat: number; lng: number };
  hexes: HexCell[];
  households: Household[];
  // v2 可选字段
  hazardGeometry?: HazardGeometry; // v3：登陆点和路径，或震中和破裂线（Harbor Bend 没有）
  region?: string;          // 例如 "tx-corpus-christi"、"ca-bay-area"
  hazardType?: HazardType;  // 旧数据没有这个字段，视为 hurricane
  facilities?: Facility[];
  dataSources?: string[];   // 真实数据来源和许可说明
  horizonMinutes?: number;  // 事件时长，缺省为 4320（72 小时）
  eventLocalHour?: number;  // 灾害发生时的当地小时（0–23），决定 awayDaytime 是否起作用
  eventWeekday?: boolean;   // 是否工作日：上课时间 + 工作日 = 孩子在学校
}

// 真实情况。只有模拟器知道；引擎只在训练（回测事件）和评估（留出家庭）时读取。
export interface TruthRow {
  householdId: string;
  damage: Damage;
  safety: 'safe' | 'needs_help';
  peril: Peril | 'none';
  // v3：需要帮助的类型。life_safety = 现在就有危险（转 911 / 当地机构）；assistance = 需要协助（住所、供电、药品、交通），由 State Farm 客服跟进
  needType?: NeedType;
  // v3：人在哪里（灾后响应期间）。home = 在家；away = 灾害发生时不在家（上班 / 上学），看不到房子；displaced = 因房屋受损已离开（知道损失）
  location?: Whereabouts;
  // v3：away 的人回到家的时间（模拟分钟）。回家后房子损失 ≥ 2 的人会再离开（displaced，知道损失），否则在家
  returnMin?: number;
}

export type NeedType = 'life_safety' | 'assistance' | 'none';
export type Whereabouts = 'home' | 'away' | 'displaced';
export type Need = 'medical' | 'power_for_device' | 'shelter' | 'water_food' | 'transport' | 'inspection' | 'other';
// Need 的取值：medical, power_for_device, shelter, water_food, transport, inspection, other（types-only 文件，不放常量）

export type SimEvent =
  | { kind: 'sms_sent'; t: Minutes; householdId: string;
      delivered?: boolean } // v3：运营商送达回执。false = 未送达（手机没电 / 没信号 / 坏了）；缺省视为已送达
  | { kind: 'sms_reply'; t: Minutes; householdId: string; safety: 'safe' | 'needs_help';
      damage: Damage | null; // v3：null = 回复没有描述房子（例如人不在家），损失未知
      lifeSafety?: boolean;  // v3：有生命危险的信号（被困、受伤、煤气、医疗设备断电、泛泛的"救命"）
      needs?: Need[];        // v3：具体需求（不是生命危险）
      notHome?: boolean;     // v3：回复的人不在房子里（人和房子分开：人安全 ≠ 房子已查勘）
      channel?: 'sms' | 'call'; // v3：call = 坐席电话联系上
      text?: string;       // v2：自由文本回复（可能是多语言），由 Claude 解析成 safety/damage/needs
      language?: string }  // v2：回复所用语言
  | { kind: 'claim'; t: Minutes; householdId: string; peril: Peril; reportedDamage: Damage }
  | { kind: 'field_report'; t: Minutes; householdId: string; adjusterId: string; safety: Safety;
      damage: Damage | null }; // v3：null = 只看了人、没评估房子（夜里 / 进不去），房子仍算未查勘

// data/backtest/*.json 和 data/live.json 的格式
export interface EventBundle {
  world: World;
  events: SimEvent[];   // 按 t 升序
  truth: TruthRow[];    // 实时事件的 truth 只用于演示里的留出集评估
}

// data/model.json：回测校准后的模型参数
export interface ModelParams {
  version: number;
  features: string[];   // 特征名，顺序和权重一一对应
  severe: { bias: number; weights: number[] };     // 预测 P(damage >= 2)
  needsHelp: { bias: number; weights: number[] };  // 预测 P(safety = needs_help)
  sourceTrust: { hazard: number; sms: number; claims: number }; // 0–1，展示用的数据源可信度
  calibration: {
    brier: number; ece: number; heldOutEvent: string;
    auc?: number;                                          // v2 可选
    needsHelp?: { brier: number; ece: number; auc: number };
    baseline?: { brier: number; ece: number; auc: number }; // 只看灾害强度的基线
    // v3 区间：按格子做聚类 bootstrap 的 95% 置信区间（留一事件预测汇总）
    brierCI?: [number, number];
    aucCI?: [number, number];
    eceCI?: [number, number];
    brierRange?: [number, number];   // 各次留一事件的最小 / 最大值（事件之间的真实差异，不是抽样误差）
    bss?: number;                    // Brier skill score = 1 - brier / 基线 brier（不受事件强度影响，更可比）
    bssRange?: [number, number];
    // 格子严重户数 90% 区间在留出事件上的实际覆盖率（应接近 0.9）和平均宽度
    cellIntervalCoverage?: number;
    cellIntervalMeanWidth?: number;
  };
  // v3：格子层面的共享误差方差（超出二项分布的部分，相对于未核实户预期严重数的平方），由留一事件回测估计
  cellOverdispersion?: number;
  // v3：区间每侧的尾部概率，由回测校准：在留出事件上覆盖率仍 ≥ 90% 的最大值（越大区间越窄）
  cellIntervalTail?: number;
  region?: string;      // v2：这个模型对应的地区
  hazardType?: HazardType;
  trainedOn: string[];  // 用了哪些回测事件
}

export interface HouseholdEstimate {
  householdId: string;
  pSevere: number;
  pNeedsHelp: number;
  uncertainty: number;  // 0–1，越大越拿不准
  verified: boolean;    // 有现场报告
  inspectScore?: number; // v2：主动查勘的推荐分
}

export interface HexEstimate {
  hex: HexId;
  households: number;
  expectedSevere: number;   // 预计严重受损的户数
  severeLo?: number;        // v3：严重受损户数的 90% 区间下界
  severeHi?: number;        // v3：90% 区间上界
  maxPNeedsHelp: number;
  severity: number;         // 0–1
  confidence: number;       // 0–1
  priority: Priority;
  verification: Verification;
  silence: number;          // 0–1，应有信号却没有信号的程度
  counts: { smsSent: number; smsReplies: number; claims: number; fieldReports: number }; // 按户去重的计数
  hazard?: number;          // v2：0–1 灾害分，验证规则用它
  reason?: string;          // v2：给界面的一句话解释
  silenceCause?: 'away' | 'trapped' | 'outage' | 'unknown'; // v2：沉默的主要原因
}
