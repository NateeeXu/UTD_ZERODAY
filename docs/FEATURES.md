# 优先级特征设计 + Claude API 用法

> 结论：设计上归纳成 **16 个核心因素**，分 4 组；实现的模型有 **45 个特征**（`engine/src/features.ts` 的 `FEATURE_NAMES`：灾害 9、静态属性 19、短信 12、理赔 5）。每个因素都要满足三条：① 有真实依据；② 模拟器里会真的影响结果（否则只是噪声）；③ 能对应到一个具体动作（先联系谁、用什么语言、转介到哪里）。
> 原则：按"需要什么帮助"排序，而不是按"是谁"排序。**种族、族裔、收入不作为优先级特征**，只用于事后的公平性审计。

## 一、依据（为什么是这些因素）
| 发现 | 来源 |
|---|---|
| 卡特里娜飓风中，75 岁以上只占新奥尔良人口约 6%，却占死亡人数约 50% | [NBC News](https://www.nbcnews.com/news/amp/wbna26444326)、[PMC 研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC3098037) |
| 飓风 Ian 有年龄记录的 87 名死者中，61 人在 60 岁以上；原因包括行动不便、缺交通工具 | [AARP](https://www.aarp.org/livable-communities/tool-kits-resources/info-2022/disaster-risks-to-older-adults/) |
| FEMA 和 HHS 采用 CMIST 框架：按功能需求（沟通、维持健康、独立性、支持与安全、交通）识别需要帮助的人，不按诊断或身份 | [HHS ASPR TRACIE](https://files.asprtracie.hhs.gov/documents/access-and-functional-needs.pdf)、[ASPR](https://www.aspr.gov/at-risk/Pages/at-risk_afn.aspx) |
| CDC 社会脆弱性指数（SVI 2022）：16 个变量、4 个主题；家庭特征主题含 65 岁以上、17 岁以下、残障、单亲、英语能力；住房与交通主题含移动房屋、拥挤、无车 | [SVI 2022 文档](https://www.atsdr.cdc.gov/place-health/media/pdfs/2024/10/SVI2022Documentation.pdf)、[SVI ZCTA 文档](https://svi.cdc.gov/map25/data/docs/SVI2022Documentation_ZCTA.pdf) |
| 龙卷风死亡（1980–2014）：移动房屋占比是两大因素之一，占比翻倍的县死亡人数多约 62% | [Claims Journal](https://www.claimsjournal.com/news/national/2017/05/04/278286.htm) |
| 白天和夜间人口分布差别很大，暴露评估要分时段 | [ORNL](https://ornl.gov/news/ornl-program-could-help-city-dwellers-survive-disaster)、[Freire 等 2015](https://www.idl.iscram.org/files/sergiofreire/2015/1217_SergioFreire_etal2015.pdf) |
| 宠物主人常因宠物拒绝撤离（但统计上不是撤离失败的显著因素） | [PMC：Irene 研究](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4494278/) |

## 二、16 个核心因素（模型里展开成 45 个特征）
| 组 | 特征 | 数据来源 | 影响 | 对应动作 |
|---|---|---|---|---|
| **A 灾害与房屋**（4） | 灾害强度指数（风速 / 洪水 / 地震烈度） | 模拟 + USGS 情景 | 严重受损 | — |
| | 保障缺口（洪水没洪水险、地震没地震险） | 保单标记 | 不报案（沉默的另一个原因） | 主动联系，转介 FEMA 援助 |
| | 房屋脆弱度（移动房屋） | ACS / SVI 按普查区比例抽样 | 严重受损 + 人身危险 | 优先查勘 |
| | 液化易发（仅地震） | USGS / 替代指标 | 严重受损 | — |
| **B 功能需求 CMIST**（6） | 75 岁以上 / 65 岁以上 | ACS | 需要帮助，回复率低 | 优先联系 |
| | 独居 | ACS | 需要帮助，沉默 | 优先联系 |
| | 依赖电力的医疗设备 | 客户自愿提供（参考 HHS emPOWER） | 停电即危险 | 转交应急机构 |
| | 残障或行动不便 | ACS / SVI | 需要帮助 | 优先联系 |
| | 无车 | ACS / SVI | 无法撤离 | 优先联系 |
| | 英语能力有限 | ACS / SVI | 看不懂短信，沉默 | 模拟的问候短信只用英语（回复率 × 0.55）；按母语外联在路线图上 |
| **C 家庭情境**（2） | 有 18 岁以下孩子 | ACS | 住房需求更急 | 优先审核临时住宿；转介最近的学校避难所 |
| | 白天通常不在家（通勤） | LEHD LODES | **沉默不等于危险** | 区分"人不在家"和"人被困" |
| **D 实时信号**（4） | 短信回复（安全 + 损坏程度 + 自由文本里的需求） | 投保人 | 直接证据 | — |
| | 格子回复率（按基站中断修正）= 沉默分 | 计算 | 待核实 | 派人核实 |
| | 实际报案 ÷ 应有报案 | State Farm 数据 | 损失规模 | — |
| | 现场报告 | 理赔员 | 真实结果，覆盖估计 | 学习循环 |

距离最近的开放避难所（学校、医院）不作为模型特征，而是在派单和转介时使用。

**不建议加的**：种族和族裔（法律和伦理风险）、收入（只做公平性审计）、宠物（没有统计显著性，可以写进短信问卷）。

## 三、两个模型怎么用这些特征
- **P(严重受损)**：主要看 A 组和 D 组。
- **P(需要帮助)**：主要看 B 组、C 组和 D 组。
- **沉默解释**：如果一户既"白天不在家"又没回复，沉默多半是因为人不在；如果一户是"独居老人 + 无车 + 依赖医疗设备"又没回复，沉默多半是因为人被困。演示时，地图上的沉默格子要显示主要原因。

## 四、Claude API 用在哪里
**原则：LLM 只做理解和表达，不做打分。** 所有数字和优先级都来自引擎；LLM 的输出要经过格式校验，失败时退回关键词规则。

| 用途 | 输入 → 输出 | 为什么需要 LLM |
|---|---|---|
| ① 理解自由文本短信 | "屋顶没了，妈妈用制氧机，停电了" → `{safety: needs_help, damage: 3, needs: [power_medical], language: zh}` | 真实回复不会只有 1–3 这种数字 |
| ② 多语言外联（路线图，未实现；模拟器假设问候短信只用英语） | 按户的语言生成问候短信 | 科珀斯克里斯蒂西语人口多；湾区有中文、西语、越南语 |
| ③ 给主管的解释 | 引擎数字 → "为什么这个格子是 P0" 的一句话说明 | 评委和主管一眼看懂 |
| ④ 理赔员现场备注 | 口述或打字备注 → 结构化的现场报告 | 现场填表太慢 |

**在哪里调用**
- **实际实现：一个 Node worker**（`spacetimedb/scripts/claude-worker.ts`，官方 SDK `@anthropic-ai/sdk`），订阅 `reply_inbox` 里 `pending` 的行，处理完再调用服务端函数 `submit_parsed_reply` 写回（见 `docs/CLAUDE_PARSER.md`）。
- **没有实现、留在路线图上**：Spacetime 的 procedure。procedure 能用 `ctx.http.fetch` 调外部 API，reducer 不能（[Spacetime 文档](https://spacetimedb.com/docs/procedures)）。

**API key**
- 公开仓库里**绝不能**出现 key。
- Node worker 的 key 放 `spacetimedb/.env`（已被 `.gitignore` 忽略），只从 `ANTHROPIC_API_KEY` 环境变量读取，不进前端、Spacetime 表或 bindings。

**模型**
- 产品里调用的 API 用 **Claude Sonnet 5.5**（`claude-sonnet-5-5`，团队决定）。短信理解这种简单任务，把推理强度（effort）设为 `low`，速度更快、更省钱。
- 粗算（token 数是假设，没有实测）：Sonnet 5.5 输入 $2、输出 $10（每百万 token），每条回复按 300 个输入、100 个输出 token 算约 $0.0016，1,400 条约 $2.2。v2 的 system prompt 比 300 个 token 长，实际输入会更多。回放里 bundle 自带的回复不调用 Claude，只有回复页现场输入的自由文本（`submit_raw_reply`）才会走 worker。如果你们想更省，可以自己决定换成 Claude Haiku 5.5。

**需要的数据改动**：模拟器要生成一部分**自由文本、多语言**的短信回复，契约里的 `sms_reply` 要加可选字段 `text` 和 `language`。
