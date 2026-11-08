# 理赔员手机端（Field Adjuster）前端规格

> 读者：前端。说明用中文；界面文案、字段名、表名、reducer 名保持英文，**界面文案照抄**。
> 设计稿：5 屏（Tasks / Home / Field report / Report sent / Can't make contact），本文已合入设计评审的全部决定，和设计稿冲突时以本文为准。
> 后端契约按正在实现的版本写（`submit_field_report` 多了 `memberMissing`，`close_household` 多了 `note`）。重新生成 bindings 后再接。
> 表和字段细节：`docs/SPACETIME_API.md`（第 4–6 节）、`docs/DATA_TYPES.md`（第 5–7 节）。

## 1. 目标与原则

1. 一件事：理赔员在门口 30 秒内报完"人怎么样、房子怎么样"，主管地图在一秒内更新。
2. 生命安全优先：选 Needs help 时界面先让人自己打 911。我们的报告只开**转介（referral）**，**不是派遣（dispatch）**，任何文案都不能暗示"救援已出发"。
3. 不说假话：只有 reducer 提交成功（或订阅里出现这条报告）才显示"已发送"；`live` 标记反映真实连接；手机上不显示百分比，不说 "verified / confirmed"（这两个词只在主管端用，例如 "Severe · your report (estimate 70%)"）。
4. 最少隐私：列表只显示能指导行动的需求（Medical device、Speaks Spanish）；不显示年龄、独居这类标签；发送成功后清掉本地缓存；不做带内容的通知。
5. 单手操作：选项放在屏幕下半部，点击区域至少 56 px 高；选中样式全局统一（黑底白字 + 实心圆点），红色只用于 911。

## 2. 每个屏幕

### 2.0 公共部分

**连接和加入**
- 连接方式同 `SPACETIME_API.md` 第 7 节。token 存在 `localStorage['triage-token-adjuster']`；数据库名从 `?db=` 读，默认 `VITE_SPACETIME_DB`。
- 加入页（只在 `my_member` 为空时出现）：
  - 输入框 "Your name"、"Staff passcode"（`type=password`）。
  - 按钮 "Join as adjuster" → `joinAs({ role: 'adjuster', name, passcode })`；失败时显示 "Wrong passcode or name".
  - **口令只由用户输入**：不写进代码、env 或 localStorage。

**订阅**：先订阅全局表，再按每个派单的 `householdId = X`、`hex = H` 各订一组。`my_assignments` 变化时重新订阅。
```sql
SELECT * FROM my_member;  SELECT * FROM my_assignments;  SELECT * FROM replay_state;  SELECT * FROM world
SELECT * FROM household          WHERE id = X
SELECT * FROM household_estimate WHERE household_id = X
SELECT * FROM household_followup WHERE household_id = X
SELECT * FROM field_report       WHERE household_id = X   -- 发送状态机的查重要用
SELECT * FROM sms_sent           WHERE household_id = X
SELECT * FROM sms_reply          WHERE household_id = X
SELECT * FROM hex WHERE hex = H;  SELECT * FROM hex_stats WHERE hex = H
SELECT * FROM facility WHERE id = <household.nearestSchoolId>
SELECT * FROM member WHERE identity = <assignment.assignedBy>
```

**顶栏 `live` 标记**（每屏右上角）：值来自 `useSpacetimeDB().isActive`、订阅的 `onApplied` 和 `navigator.onLine`，不许写死。
| 状态 | 条件 | 文案 |
|---|---|---|
| 绿色描边 | isActive 且订阅已应用 | `live` |
| 琥珀色 | 曾经连上，现在 `isActive = false`（SDK 自动重连，间隔 1–30 s） | `reconnecting` |
| 灰色 | `navigator.onLine === false` | `offline` |
| 发件箱有未发报告时 | 后缀 | `· 1 unsent` |

**派生字段**（全部在客户端算，各屏共用）
| 界面 | 规则 |
|---|---|
| `Home #006142` | `household.id` 的最后 6 位数字 |
| `District 91` | `h3.cellToParent(hex, 7)` 在全部 res-7 父格中的稳定序号，和主管端一致 |
| 模拟时间 `T+14h 30m` | `replay_state.simMinutes`（事件时间用该行的 `t`） |
| 等级 `High / Med / Low` | `pNeedsHelp`：≥0.5 High，≥0.25 Med，否则 Low。`pSevere`：≥0.5 High，≥0.2 Med，否则 Low（和引擎 P0/P1 阈值一致）。**手机上不显示任何百分比** |
| 任务类型 badge | `Welfare check`：`!estimate.accounted`，或 `escalation` 属于 `field_visit / locate / recheck / emergency_referral / referral_*`。其余为 `Property inspection` |
| `Silent 14 h` | 只在 `!accounted` 时显示。小时数 = (`simMinutes` − 最近一次 `sms_reply.t`；没有回复就用第一条 `sms_sent.t`，再没有就用 0) / 60 |
| `May need help leaving` | `age75 \|\| disability \|\| noVehicle \|\| (age65 && livesAlone)` |
| `Medical device` | `medicalDevice` |
| `Speaks Spanish` | `limitedEnglish && primaryLanguage` 不是 `en`。语言名：es Spanish、zh Chinese、vi Vietnamese、tl Tagalog、ko Korean、fr French、de German、ru Russian、ar Arabic；`other*` 显示 "Needs interpreter" |
| 地区名 | `world.region`：`tx-corpus-christi` → Corpus Christi，`ca-bay-area` → Bay Area，没有 → Harbor Bend |

### 2.1 屏幕 1 · Tasks

目的：看到我的任务，按顺序出发。

从上到下：
1. **地图**（约 40% 高）。底图同主管端（Esri Light Gray）。
   - 显示：编号钉 1..n（黑底白字，P0 加红圈）；已完成的任务显示绿勾钉；自己的位置是蓝点（`navigator.geolocation.watchPosition`，用户拒绝就不显示，也不报错）；路线是一条虚线，从蓝点依次连到 1→2→3（直线，只表示顺序）。
   - **不显示**六边形热力层和图例。
2. **浮在地图上的卡片**："Field tasks" / "J. Ortiz · Corpus Christi · T+14h 30m"，右侧是 `live` 标记。
3. **底部面板**（没有 Tabs，Suggested 已删）。小标题 "NEXT UP"，右侧写 "3 open · 1 done"。
4. **Next up 卡片**（第一个未完成的任务）
   - 第一行：`P0` badge、类型 badge（`Welfare check` / `Property inspection`）、`Silent 14 h`。
   - 标题："Home #006142"。
   - 一行文字："District 91 · Help: High · Damage: High"。
   - 需求 chip 最多 2 个，只能是 `Medical device` 或 `Speaks Spanish`。
   - 按钮："Directions"（描边，打开地图 App）和 "Open home"（主按钮）。
5. **其余未完成任务**：每行显示编号、P badge、"Home #005321"、"District 58 · Medical device"，右侧 "Help: High"。发件箱里有未发报告的行加琥珀色 tag "Unsent"。
6. **已完成任务**：行首绿勾，右侧 "Reported T+13h 05m"。绿勾**只表示任务做完了**；人的状况另起一个小 tag：
   - "Everyone safe"
   - "Referral open"（红）
   - "Someone missing"（琥珀）
   - "Locate pending"（`escalation = locate`）

数据：`my_assignments`（`status = 'assigned'` 为未完成，`'done'` 为已完成；`cancelled` 的不显示）、`hex_stats.priority`、`household_estimate`、`household`、`field_report.t`。
排序：P0 → P1 → P2，同级按 `pNeedsHelp` 从高到低，再按 `createdAt`。钉子上的编号就是这个顺序。
状态：
- 加载中：骨架屏。
- 没有任务："No tasks yet. New tasks appear here automatically."
- 来了新任务：页内 toast "New task assigned"，**不带地址和住户信息**。不做系统通知。

### 2.2 屏幕 2 · Home

目的：出发前和到门口时，搞清楚为什么来、找谁、怎么进门。

顶栏："‹ Tasks" · "Task 1 of 3 · T+14h 30m" · `live`。

从上到下（**Welfare check** 的顺序；Property inspection 的差别见本节末尾）：
1. **地图条**：一个钉、自己的位置、一个 "Directions" 按钮（全屏只有这一个 Directions）。
   - iOS：`https://maps.apple.com/?daddr=lat,lng`；其他系统：`https://www.google.com/maps/dir/?api=1&destination=lat,lng`。
2. **Badge 行**：`P0`、`Welfare check`、`Silent 14 h`。每种 chip 在一屏里只出现一次。
3. **标题**："Home #006142"。下面一行："District 91 · assigned by M. Reyes · 12 min ago"（`assignedBy` → `member.name`；`createdAt` 是真实时间，所以用"几分钟前"）。
4. **地址块**
   - 地址行：有 `household.address` 就显示（待后端）。没有就显示 "Near {facility.name}"（来自 `nearestSchoolId`），后面跟坐标。
   - "Access: {household.accessNote}"（待后端）；没有这个字段就整行隐藏。
   - "Phone on file" 旁边放一个 "Call" 按钮。合成数据没有号码，点了弹 toast "Demo household: no real number"。`phoneOnFile = false` 时显示 "No phone on file · try emergency contact"，不显示按钮。
5. **WHY YOU'RE HERE**：客户端按模板拼一句话，不用 `hex_stats.reason` 原文。
   - 灾害：飓风 `windMph ≥ 74` → "Hurricane-force winds here"；`floodDepthFt ≥ 1` → "Flooding here"；地震 `shakingMmi ≥ 8` → "Severe shaking here"。
   - 沉默：没回复过 → "and no reply in 14 hours."
   - 原因（`hex_stats.silenceCause`）：
     - `trapped` → "Silence here most likely means people are still at home."
     - `away` → "Many people here are at work; they may not be home."
     - `outage` → "Cell towers are down here, so silence may just mean no signal."
   - 有 `May need help leaving` 时加 "This home may need help leaving."
   - 结尾：Welfare 加 "Knock first."；Property 加 "Inspect the house; note anyone you see."
6. **STATUS**（两行，替代原来的数字行）
   - PEOPLE，按 `escalation` 显示：
     - `sms_*` / `agent_call` / `field_visit` → "Not heard from"
     - `locate` → "Not seen at visit · locate"
     - `recheck` → "Last heard over 24 h ago"
     - `emergency_referral` / `referral_*` → "Needs help · referral open"
     - `assistance` → "Asked for help (not urgent)"
     - `accounted` / `verified` → "Heard from"
     - `closed` → "Closed · {closureReason}"
   - PEOPLE 下面一行联系记录："Texted T+0h 20m · no reply"（来自 `sms_sent` / `sms_reply`）。后端如果补了尝试次数，就换成 "3 attempts · last T+3h 20m"。
   - HOME："Not inspected · Damage likely: High"；`verified` 时显示 "Inspected"。
7. **WHO LIVES HERE**：只放这三种 chip：`May need help leaving`、`Medical device`、`Speaks Spanish`。**不显示** 75+、Lives alone、No vehicle。
8. **底部固定区**：主按钮 "Start field report"，下面是文字链接 "Can't make contact?"（打开屏幕 5）。

**Property inspection 的差别**：STATUS 里 HOME 行排在 PEOPLE 前面；WHY 后面加 **COVERAGE**：`Homeowners/Renters/Condo`、`✓ Wind`、`✓ Flood policy`/`✗ Flood policy`、`✓ Earthquake`/`✗ Earthquake`，当前灾种对应的那项排第一。Welfare check 不显示 COVERAGE。

### 2.3 屏幕 3 · Field report

顶栏："‹ Home #006142" · `live`。
标题 "Field report"，副标题 "People and property are reported separately."。顶部要紧凑，让选项落在屏幕下半部。选好 PEOPLE 后，自动滚动，让 HOME 区落进下半屏。"Send report" 固定在底部。

**1 · PEOPLE**（右侧小字 "Who did you see?"，单选，必选；Property inspection 也一样，人永远先问）
| 选项（标题 / 说明） | `safety` | `memberMissing` |
|---|---|---|
| Safe / "Everyone who lives here is accounted for" | `safe` | false |
| Needs help / "Someone seen is hurt, stuck or needs care" | `needs_help` | false（勾选下面的框就是 true） |
| Some seen, someone missing / "We saw some people; someone who lives here is missing" | `unsure` | true |
| Nobody seen / "No one answered or seen — still unaccounted → Locate (emergency contact, shelters)" | `unsure` | false |

选中后，选项下方出现说明块：
- **Needs help**（红色块，最醒目）：
  - 文案 "Anyone in danger? Call 911 yourself now." / "This report also sends a referral — not a dispatch."
  - 全宽红色大按钮 `Call 911 now`（`<a href="tel:911">`；只打开拨号界面，不会自动拨出）。
  - 勾选框 "Someone who lives here is also missing"，勾上后 `memberMissing = true`。
- **Some seen, someone missing**（琥珀色）："Sending opens a missing-member referral. Add who is missing and where they were last seen." 备注的 placeholder 换成 "Who is missing? Where were they last seen?"。
- **Nobody seen**（灰色）："You can still inspect the house. People stay unaccounted; next step is Locate."

**2 · HOME**（右侧小字 "How damaged is the house?"）
- 布局：0–3 排成 2×2 网格，"Couldn't assess" 单独一行，放在最下面，样式要弱。
- 文案（照抄）：
  - "0 None" / "No visible damage"
  - "1 Minor" / "Glass, shingles, fence"
  - "2 Severe" / "Structural cracks, water inside, roof partly gone"（地震世界改为 "Structural cracks, chimney down, house shifted"）
  - "3 Uninhabitable" / "Collapsed, off the foundation, unsafe"
  - "Couldn't assess" / "Exception: give a reason"
- 选 0–3 时，`damage` 就是这个数字。

**Couldn't assess 是例外，不是正常结果**：对保险公司来说，看房子是理赔员的本职工作。
- 选了它，必须**同时**满足两条：
  - 选一个原因 chip："Unsafe to enter"、"No access (flooded, cordon, red-tagged)"、"Dark, no power"。
  - 备注至少 3 个字符。
- 满足后才能发送，`damage = 255`。
- note 最前面自动加一行 `Not assessed: {reason}`。后端会拒绝没有 note 的 255。
- 选中后显示："House not inspected yet — will be re-assigned"。这户留在查勘队列里，以后会再派人来查。

**按保单调整 HOME 区**：字段 `policyType`（`homeowners` / `renters` / `condo`；没有值按 `homeowners` 处理）、`windCovered`、`floodPolicy`、`earthquakeEndorsement`，以及 `world.hazardType`。
| 情况 | HOME 区怎么变 |
|---|---|
| Property inspection + `homeowners` | 必填：要么选 0–3，要么选 Couldn't assess 并给出原因 |
| Property inspection + `condo` | 同上。标题改为 "How damaged is the unit?"，说明 "Inside the unit; the building is the association's" |
| `renters`（任何任务） | 房屋结构归房东的保险，不归 State Farm 评估。区块标题改为 "Their belongings and tonight"，内容见表下 |
| Welfare check（非 renters） | HOME 区选填，标题加 "(optional)"；不选就发 255，note 自动加 `Not assessed: welfare check` |
| 有灾种不在保障内，且选了 damage ≥ 1 | 照样记录损坏，同时在 HOME 区下方显示琥珀色提示（"do not promise payment" 不能删），见表下 |

renters 的区块内容：
- "Contents" 选 None / Minor / Severe。
- "Can they stay here tonight?" 选 Yes / "No — needs shelter or a place to stay"。后者对应额外生活费用（ALE）的需求。
- 两项都写进 note 的第一行：`Contents: Severe · Stay tonight: No`。主管端靠这一行解析。
- 房屋 0–3 折叠成 "Building (optional)"。不填就发 255，note 自动加 `Not assessed: renter, building is the landlord's`。

不在保障内的灾种和提示文案：
- 飓风：`!floodPolicy` → "Flood damage: Not covered by this policy — refer to FEMA / NFIP, do not promise payment"；`!windCovered` → "Wind damage: Not covered by this policy — refer to FEMA, do not promise payment"。
- 地震：`!earthquakeEndorsement` → "Quake damage: Not covered by this policy — refer to FEMA, do not promise payment"。

**NOTE**：
- 标题 "NOTE · OPTIONAL"；Couldn't assess 时改为 "NOTE · REQUIRED"。
- placeholder "What you saw, who you spoke to"；上限 500 字符，显示计数。
- 快捷 chip：Trapped / Injured / Medical / Needs shelter / Neighbour said。点一下在 note 里追加或删除 "Trapped. "。

**发送按钮**
- "Send report"。下面一行小字 "Updates the manager's map as soon as it's sent."
- 没选全时按钮置灰，文案改为 "Choose people and home"。
- 调用：`submitFieldReport({ householdId, safety, damage, note, memberMissing })`。成功后后端自动完成我的派单。
- 发送中、已存手机、失败等状态见第 3 节。

### 2.4 屏幕 4 · Report sent

**只有**状态机进入 `Sent` 才进这个屏（见第 3 节）。顶部地图只放这一户的钉，不画格子。地图动画在主管端。

**头部**（按报告内容变化；绿勾只表示"任务完成"）
| 报告 | 图标 | 标题 |
|---|---|---|
| `safe` | 绿勾 | "Report sent" |
| `needs_help` | 红色 `!`，**没有绿勾** | "Referral created (not a dispatch)" |
| `unsure` + `memberMissing` | 琥珀 `!` | "Missing-member referral created" |
| `unsure` | 绿勾 | "Report sent" |

副标题 "T+14h 52m · on the manager's map now"（时间取已提交那条 `field_report.t`）。

**三行结果**
- **PEOPLE**：
  - safe → "Everyone accounted for"。
  - needs_help → "Needs help"；missing → "Someone missing"。两者后面都跟一个转介 pill，按 `household_followup.referralStatus` 实时变：
    - `''` → "Referral created · not a dispatch"
    - `referred` → "Referred to 911 / local agency"
    - `acknowledged` → "Agency acknowledged"
    - `resolved` → "Resolved"
  - Nobody seen → "Still unaccounted"，下一行 "Next: Locate (emergency contact, shelters)"，再给一个文字链接 "Locate failed? Close home"（打开屏幕 5）。
- **HOME**：
  - 选了 0–3 → "Severe · your report"（不写 verified、confirmed，也不写百分比）。
  - 选了 255 → "House not inspected yet — will be re-assigned"。
  - renters → "Contents: Severe · Stay tonight: No"。
- **AREA**：
  - 文案 "Severe in cell: 3–11 → 5–8"，下一行 "Nearby homes re-estimated too"。
  - 前一个范围：真正调用 reducer 前，从 `hex_stats.severeLo/severeHi` 快照一份。
  - 后一个范围：提交后和 `field_report` 同一个事务送到的 `hex_stats` 行。
  - 取整显示；上下界相等时只写一个数；没变化时写 "Severe in cell: 5–8 (no change)"。
  - 演示的高潮：手机上这行出现的同时，主管地图上这一格和邻居在动。

**按钮**
- 非 needs_help：
  - 主卡片 "NEXT UP · 2 OF 3"：黑底，显示下一户，点了进它的 Home。
  - 文字链接 "Back to all tasks"、"Send correction"。
- needs_help：
  - 主按钮 "Add update"：打开表单，沿用原来的 safety 和 damage，note 清空并自动聚焦，标题改为 "Update"。
  - Next up 卡片降为描边的次要样式。
  - 文字链接 "Back to all tasks"、"Send correction"。
- "Send correction"：打开表单，全部预填，标题改为 "Correction"，note 前面加 "Correction: "。
- 两种更新都再调一次 `submit_field_report`。引擎只用这户最新的一条。改报 safe 不会关闭已开的转介，转介由主管处理。
- 全部任务都做完时，Next up 位置显示 "All tasks done"。

### 2.5 屏幕 5 · Can't make contact（Home 上弹出的底部面板）

标题 "Can't make contact"。说明：
"Only with a documented reason. The home leaves the unaccounted list; the reason and your name are logged. It can be reopened."

| 选项（标题 / 说明） | 调用 | 备注 |
|---|---|---|
| Can't get there / "Road blocked or flooded. Skips this task; the home stays open for someone else." | `updateAssignment({ id, status: 'cancelled' })` | 不关闭这户；这个 reducer 没有 note 参数，所以隐藏备注框 |
| Vacant / "No one lives here" | `closeHousehold({ householdId, reason: 'vacant', note })` | 备注必填 |
| Not in the area / "Household confirmed elsewhere" | `reason: 'not_in_area'` | 备注必填 |
| Unreachable after a visit / "You visited; locate attempts failed" | `reason: 'unreachable_after_visit'` | 备注必填。只有这户已有 `safety = 'unsure'` 的 `field_report` 才能点；否则置灰，并提示 "Send a 'Nobody seen' report first." |

- 备注框："Why? What did you check?"，至少 3 个字符（后端也会检查）。
- 底部两个按钮："Cancel"，以及主按钮。主按钮文案跟着选项变：选 Can't get there 时是 "Skip task"，其余是 "Close home"。没选选项或备注不够 3 个字符时置灰。
- `close_household` 成功后，如果派单还是 `assigned`，再调 `updateAssignment({ id, status: 'done' })`（待后端确认它会不会自己做）。
- 成功后回到 Tasks，toast "Home #006142 closed" 或 "Task skipped"。
- 失败时在面板里显示后端返回的原文，面板不关。

### 2.6 任务更新提示（派单之后这户有了新消息）

任务派出后不会自动消失或换掉，但如果这户在派单之后有了新消息，要在 Tasks 卡片和 Home 顶部显示一条提示，让理赔员自己决定还去不去。

- 数据：对每个 `assigned` 的户订阅 `sms_reply`、`field_report`、`household_followup`（按 householdId 过滤）。只看 `ingestedAt` 晚于 `assignment.createdAt` 的行，时间显示用事件的 `t`（T+h:mm）。
- 提示（取最新一条，按优先级）：

| 新消息 | 提示条（黄色，红色的除外） | 按钮 |
|---|---|---|
| 回复 `needs_help`（或 `lifeSafety`） | 红色："Now needs help — referral opened · T+15h 05m" | 主按钮 Open home（尽快去） |
| 别的理赔员提交了报告（`adjusterId` 不是我） | "Visited by {name} · T+14h 40m · People: {Safe / Nobody seen}" | Still go / Skip |
| 回复 `safe`（短信或坐席电话 `channel = 'call'`） | "Replied safe · T+15h 05m"（`notHome` 时加 "· not at home"） | Still go / Skip |
| 这户被结案（`household_followup.closureReason`） | "Closed: {reason} by {closedBy}" | OK（任务已自动完成） |

- Skip 调用 `update_assignment(id, 'cancelled')`，不结案；Still go 只关掉提示。
- 回复 `safe` 只代表人报了平安，房子可能还没查勘：如果这是 Property inspection 任务，提示里加一句 "House still not inspected"，并且默认按钮是 Still go。
- 不弹系统通知，也不在通知里显示内容（隐私）。

## 3. 发送状态机

只用于 `submit_field_report`。发件箱存在 `localStorage['adjuster-outbox-v1']`，每条记录：
`{ opId, householdId, assignmentId, safety, damage, note, memberMissing, baseCount, createdAt, tries }`。
- `opId`：客户端生成的 UUID，作为发件箱的键。
- `baseCount`：第一次发送前，订阅里"这户由我提交的 `field_report`"的条数。
- 发件箱**只在没发出去时**保存这条报告；不保存住户详情。

```
             tap Send（先存进发件箱，按钮锁住）
 [Draft] ─────────────────► [Sending] "Sending…"
    ▲                          │
    │                          ├─ reducer 的 Promise resolve ─────────────────────┐
    │                          ├─ 订阅里出现我的新报告（count > baseCount）────────┤
    │                          │                                                  ▼
    │                          │                                      [Sent] 删掉发件箱这条 → 屏幕 4
    │                          ├─ reducer 抛错（SenderError）──► [Failed] "Failed — {后端原文}"
    │                          │                                   ├─ Try again ─► [Sending]
    └────────── Edit ──────────┼───────────────────────────────────┘
                               └─ 没连上 / 8 s 没回音 ──► [Queued] "Saved on phone · will send"
                                                          │  自动重试的时机：重连且订阅重新应用后、
                                                          │  距上次尝试 20 s、或点 "Try now"
                                                          ▼
                                       先查重：我的报告数 > baseCount？ 是 → [Sent]；否 → [Sending]

 needs_help 看门狗：点 Send 起 30 s 内没进 [Sent]（Queued 或 Failed 都算）
   → 全宽红色块 "Not delivered — call 911 directly" + `Call 911 now`（tel:911），后台继续重试。
```

- **"我的报告"** 指 `field_report.householdId === X && ingestedBy.isEqual(myIdentity)`。用条数判断，不用时间，这样不受手机时钟偏差影响。
- **没连上时不调 reducer**（`isActive = false` 直接进 Queued）。8 s 超时以后，原来那次调用可能已经提交了，所以重试前一定先查重。最坏情况是重复一条内容相同的报告，可以接受。
- Queued 时可以离开这个屏。发件箱是全局的，在后台自己重试。Tasks 列表对应那行显示 "Unsent"。发出去以后弹 toast "Report for Home #006142 sent"。
- Failed 不自动重试，因为输入或权限有问题，重发也没用。needs_help 失败时同样显示 911 红块。
- 进入 `Sent` 后要做三件事：删发件箱条目、清草稿、释放这一户在内存里的缓存。所有本地存储里只剩 token。
- 报告的模拟时间以服务器提交时刻为准。Queued 久了以后，时间会比点击时晚，这没问题。

## 4. 演示脚本（60 秒）

**演示前**
- 数据库 `triage-loop-nateeexu-tx`。主管端先 `reset_demo`，再 `jump_to(840)`（T+14h），然后**暂停**回放，免得模拟员工抢先去这户。
- 手机已经用 "J. Ortiz" 加入，停在 Tasks。
- 从 `inspection_candidate` 里挑一户：所在格是 P0 + `needs_verification`，并且带 `May need help leaving`。

| 时间 | 主管笔记本 | 手机 | 讲什么 |
|---|---|---|---|
| 0–10 s | 点一个闪烁的 P0 格 → 选这一户 → Assign to J. Ortiz（`assign`） | 不用刷新，Next up 出现 "Home #006142"，钉子 1 | "The map says this silent cell is the worst; one tap sends a person." |
| 10–20 s | — | Open home：WHY 那句话、May need help leaving、Phone on file → Start field report | "No percentages in the field, just what to do: knock first." |
| 20–35 s | — | 选 Needs help → 红色 `Call 911 now` 出现（**别点**）→ 选 2 Severe → chip Trapped → Send report | "We never dispatch. The adjuster calls 911; our report opens a referral with a timer." |
| 35–50 s | 这一格和邻居重新上色，转介面板出现这一户并开始 30 分钟计时，accounted +1 | "Referral created (not a dispatch)"，AREA "Severe in cell: 3–11 → 5–8" | "One report, every screen, under a second; the uncertainty range narrowed." |
| 50–60 s | 点 "Refer to 911 / local agency"（`update_referral`） | PEOPLE 的 pill 实时变成 "Referred to 911 / local agency" | "Nobody is silently fine, and nobody stalls in the queue." |

**飞行模式备用**（现场网络断了，或者想主动展示可靠性）：
1. 点 Send 之前打开飞行模式。`live` 变成 `offline`，Send 后显示 "Saved on phone · will send"，列表那行显示 "Unsent"。
2. 如果报的是 needs_help，30 s 后出现 "Not delivered — call 911 directly"。这正好说明"生命安全不靠网络"。
3. 关掉飞行模式，等 `live` 恢复。发件箱自动重发，查重后只提交一次，进入屏幕 4，主管地图同时更新。
4. 想快一点就报 Safe：它没有 30 s 看门狗。

Maincloud 整个不可用时：切到本地服务器加笔记本热点（`SPACETIME_API.md` 第 2 节），或者放备用视频。

## 5. 不做的部分

- Tasks 的 Suggested tab；手机地图上的六边形热力层和图例（只留编号钉、自己的位置、路线）。
- Home 上的数字行（86% / 70% / 14 h）和完整联系记录（只留一行）；第二个 Directions；重复的 chip。
- COVERAGE 区块，除非是 Property inspection。
- 手机上的任何百分比和 "verified / confirmed" 字样。
- 系统推送，以及带内容的通知或页面标题；离线地图瓦片；拍照上传；真正的道路导航（交给地图 App）。
- 自己做的"已发送"假状态：没有提交成功就不进屏幕 4。

**等后端，先不做**（已有降级方案）：
1. `household.address` / `accessNote`。现在显示 "Near {school}" 加坐标。
2. 联系尝试次数（`staff_contact` 是私有表）。现在显示 "Texted T+… · no reply"。
3. `update_assignment` 带 note，用来记录 "Can't get there" 的原因。
4. `submit_field_report` 的服务端 `opId` 去重。现在靠客户端按条数查重。
5. `close_household` 是否自动完成派单。现在由前端补调一次 `update_assignment(done)`。
6. renters 的 contents / 今晚能不能住、Couldn't assess 的原因，目前都写在 note 的第一行；后端可以考虑改成独立字段。
