// Row types for the live (Spacetime) screens, inferred from the binding row
// definitions. Avoid module_bindings/types.ts for hex/hex_stats/household/world:
// those type aliases are still v1 until the bindings are regenerated.
import type { Infer } from 'spacetimedb';
import type HexRowDef from '../module_bindings/hex_table.ts';
import type HexStatsRowDef from '../module_bindings/hex_stats_table.ts';
import type HouseholdRowDef from '../module_bindings/household_table.ts';
import type HouseholdEstimateRowDef from '../module_bindings/household_estimate_table.ts';
import type WorldRowDef from '../module_bindings/world_table.ts';
import type ReplayStateRowDef from '../module_bindings/replay_state_table.ts';
import type MetricsRowDef from '../module_bindings/metrics_table.ts';
import type FacilityRowDef from '../module_bindings/facility_table.ts';
import type InspectionCandidateRowDef from '../module_bindings/inspection_candidate_table.ts';
import type MemberRowDef from '../module_bindings/member_table.ts';
import type AssignmentRowDef from '../module_bindings/assignment_table.ts';
import type SmsReplyRowDef from '../module_bindings/sms_reply_table.ts';
import type ClaimRowDef from '../module_bindings/claim_table.ts';
import type FieldReportRowDef from '../module_bindings/field_report_table.ts';

export type HexRow = Infer<typeof HexRowDef>;
export type HexStatsRow = Infer<typeof HexStatsRowDef>;
export type HouseholdRow = Infer<typeof HouseholdRowDef>;
export type HouseholdEstimateRow = Infer<typeof HouseholdEstimateRowDef>;
export type WorldRow = Infer<typeof WorldRowDef>;
export type ReplayStateRow = Infer<typeof ReplayStateRowDef>;
export type MetricsRow = Infer<typeof MetricsRowDef>;
export type FacilityRow = Infer<typeof FacilityRowDef>;
export type InspectionCandidateRow = Infer<typeof InspectionCandidateRowDef>;
export type MemberRow = Infer<typeof MemberRowDef>;
export type AssignmentRow = Infer<typeof AssignmentRowDef>;
export type SmsReplyRow = Infer<typeof SmsReplyRowDef>;
export type ClaimRow = Infer<typeof ClaimRowDef>;
export type FieldReportRow = Infer<typeof FieldReportRowDef>;
