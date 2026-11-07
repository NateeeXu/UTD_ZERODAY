// Triage Loop：所有模块共用的数据契约（模拟器、引擎、Spacetime 模块、前端）。
// 改这里之前先告诉队友，因为四个模块都依赖它。
// 本项目的全部数据都是合成的，不含任何真实客户信息。

export type HexId = string;      // H3 索引，分辨率 8（每格约 0.7 平方公里）
export type Minutes = number;    // 距飓风登陆的分钟数
export type Damage = 0 | 1 | 2 | 3; // 0 无损，1 轻微，2 严重，3 无法居住
export type Safety = 'safe' | 'needs_help' | 'unsure';
export type Priority = 'P0' | 'P1' | 'P2';                    // 需要多快采取行动
export type Verification = 'verified' | 'needs_verification';  // 信息够不够
export type Peril = 'wind' | 'flood';

export interface HexCell {
  hex: HexId;
  lat: number;
  lng: number;
  windMph: number;         // 峰值风速
  floodDepthFt: number;    // 洪水深度，0 表示没淹
  towerOutagePct: number;  // 0–100，基站中断比例
  analystZone: 0 | 1 | 2;  // 人工标注的受灾区：0 无，1 中度，2 严重
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
}

export interface World {
  eventId: string;          // 例如 "live" 或 "backtest-1"
  name: string;             // 虚构地名，例如 "Harbor Bend, TX"
  landfallIso: string;      // 登陆时间（ISO 字符串）
  center: { lat: number; lng: number };
  hexes: HexCell[];
  households: Household[];
}

// 真实情况。只有模拟器知道；引擎只在训练（回测事件）和评估（留出家庭）时读取。
export interface TruthRow {
  householdId: string;
  damage: Damage;
  safety: 'safe' | 'needs_help';
  peril: Peril | 'none';
}

export type SimEvent =
  | { kind: 'sms_sent'; t: Minutes; householdId: string }
  | { kind: 'sms_reply'; t: Minutes; householdId: string; safety: 'safe' | 'needs_help'; damage: Damage }
  | { kind: 'claim'; t: Minutes; householdId: string; peril: Peril; reportedDamage: Damage }
  | { kind: 'field_report'; t: Minutes; householdId: string; adjusterId: string; safety: Safety; damage: Damage };

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
  calibration: { brier: number; ece: number; heldOutEvent: string };
  trainedOn: string[];  // 用了哪些回测事件
}

export interface HouseholdEstimate {
  householdId: string;
  pSevere: number;
  pNeedsHelp: number;
  uncertainty: number;  // 0–1，越大越拿不准
  verified: boolean;    // 有现场报告
}

export interface HexEstimate {
  hex: HexId;
  households: number;
  expectedSevere: number;   // 预计严重受损的户数
  maxPNeedsHelp: number;
  severity: number;         // 0–1
  confidence: number;       // 0–1
  priority: Priority;
  verification: Verification;
  silence: number;          // 0–1，应有信号却没有信号的程度
  counts: { smsSent: number; smsReplies: number; claims: number; fieldReports: number };
}
