// Short free-text SMS replies in the household's language. The text renders the structured labels of
// the same sms_reply event (lifeSafety, needs, whereabouts, damage) and reports back the damage it
// actually conveys (null when the words do not describe the house), so text and labels never disagree.
// Policy encoded here: a generic plea ("need help", "please send someone") counts as life safety, so it
// only appears in life-safety replies; non-life-safety replies state a concrete need instead.
// All texts are synthetic templates written for this simulator.

import type { Damage, HazardType, Household, Need, Whereabouts } from '../../shared/types.ts';
import type { Rng } from '../src/rng.ts';

export const TEXT_LANGS = ['en', 'es', 'zh', 'vi', 'tl', 'ko'] as const;
type Lang = (typeof TEXT_LANGS)[number];

interface Bank {
  /** damage phrases by hazard and level 0..3 */
  dmg: Record<HazardType, [string[], string[], string[], string[]]>;
  /** vague damage phrases (ambiguous level 1-2) */
  vague: string[];
  safe: string[];
  help: string[];
  helpUrgent: string[];
  /** earthquake-specific urgent help phrases */
  quakeUrgent: string[];
  medical: string[];
  kids: string[];
  elder: string[];
  noPower: string[];
  away: string[];
  noCar: string[];
  sep: string;
}

const BANKS: Record<Lang, Bank> = {
  en: {
    dmg: {
      hurricane: [
        ['no damage here', 'house is fine', 'just branches down in the yard'],
        ['lost some shingles', 'fence down and a window cracked', 'minor roof damage'],
        ['roof partly gone, water coming in', 'big tree went through the roof', 'water inside about a foot deep'],
        ['house is destroyed', 'roof gone, walls down', 'water up to the ceiling, cant stay here'],
      ],
      earthquake: [
        ['no damage', 'stuff fell off shelves but house ok', 'everything looks fine'],
        ['cracks in the walls', 'chimney cracked', 'broken windows and dishes everywhere'],
        ['chimney fell through the roof', 'big cracks, door wont close, house tilted', 'part of the ceiling came down'],
        ['house came off the foundation', 'building collapsed', 'house is red tagged, cant go back in'],
      ],
    },
    vague: ['house is a mess', 'not sure how bad, its dark', 'some damage i think'],
    safe: ['we are ok', 'everyone is safe', 'all good here', 'we\'re fine'],
    help: ['need help', 'please send someone', 'can someone check on us'],
    helpUrgent: ['trapped, please send help', 'need help now', 'water rising, help'],
    quakeUrgent: ['trapped, please send help', 'need help now', 'smell gas, need help'],
    medical: ['mom is on oxygen', 'need power for my CPAP', 'my dad needs dialysis'],
    kids: ['kids are with me', 'baby is ok'],
    elder: ['my grandma is 85 and cant walk', 'my husband is bedbound'],
    noPower: ['no power', 'phone almost dead'],
    away: ['not home, at work, dont know about the house', 'im not home yet'],
    noCar: ['no car to leave', 'cant drive out'],
    sep: ', ',
  },
  es: {
    dmg: {
      hurricane: [
        ['sin daños', 'la casa está bien', 'solo ramas en el patio'],
        ['se volaron unas tejas', 'se cayó la cerca y una ventana rota', 'daño menor en el techo'],
        ['se fue parte del techo, entra agua', 'un árbol cayó sobre la casa', 'hay como un pie de agua adentro'],
        ['la casa quedó destruida', 'no hay techo, paredes caídas', 'el agua llegó al techo, no podemos quedarnos'],
      ],
      earthquake: [
        ['sin daños', 'se cayeron cosas pero la casa bien', 'todo parece bien'],
        ['grietas en las paredes', 'la chimenea está rajada', 'ventanas rotas'],
        ['la chimenea cayó sobre el techo', 'grietas grandes, la puerta no cierra', 'se cayó parte del techo'],
        ['la casa se salió de los cimientos', 'el edificio se derrumbó', 'la casa tiene etiqueta roja'],
      ],
    },
    vague: ['la casa está hecha un desastre', 'no sé qué tan mal, está oscuro', 'creo que hay daños'],
    safe: ['estamos bien', 'todos estamos a salvo', 'todo bien aquí'],
    help: ['necesitamos ayuda', 'manden a alguien por favor', 'alguien puede venir a vernos'],
    helpUrgent: ['estamos atrapados, ayuda por favor', 'necesito ayuda ya', 'sube el agua, ayuda'],
    quakeUrgent: ['estamos atrapados, ayuda por favor', 'necesito ayuda ya', 'huele a gas, ayuda'],
    medical: ['mi mamá usa oxígeno', 'necesito luz para mi CPAP', 'mi papá necesita diálisis'],
    kids: ['los niños están conmigo', 'el bebé está bien'],
    elder: ['mi abuela tiene 85 y no camina', 'mi esposo está en cama'],
    noPower: ['no hay luz', 'casi no tengo batería'],
    away: ['no estoy en casa, estoy en el trabajo', 'todavía no llego a la casa'],
    noCar: ['no tenemos carro para salir', 'no podemos salir'],
    sep: ', ',
  },
  zh: {
    dmg: {
      hurricane: [
        ['没有损坏', '房子没事', '院子里只是有些树枝'],
        ['掉了几块瓦', '围栏倒了，窗户裂了', '屋顶有点小损坏'],
        ['屋顶掀掉一部分，在漏水', '大树砸穿了屋顶', '屋里进水一尺深'],
        ['房子全毁了', '屋顶没了，墙也倒了', '水淹到天花板，没法住'],
      ],
      earthquake: [
        ['没有损坏', '东西掉下来了，房子还好', '看起来都没事'],
        ['墙上有裂缝', '烟囱裂了', '窗户和碗碟碎了一地'],
        ['烟囱砸穿屋顶', '裂缝很大，门关不上', '天花板塌了一块'],
        ['房子从地基上移位了', '楼塌了', '房子被贴了红牌，不能进去'],
      ],
    },
    vague: ['家里一团糟', '不知道多严重，太黑了', '好像有些损坏'],
    safe: ['我们没事', '大家都平安', '这边都好'],
    help: ['需要帮助', '请派人来', '能不能来看看我们'],
    helpUrgent: ['被困住了，请救命', '马上需要帮助', '水在涨，救命'],
    quakeUrgent: ['被困住了，请救命', '马上需要帮助', '闻到煤气味，需要帮助'],
    medical: ['妈妈要用氧气', '呼吸机需要电', '爸爸要透析'],
    kids: ['孩子们和我在一起', '宝宝没事'],
    elder: ['奶奶85岁走不了路', '我先生卧床'],
    noPower: ['停电了', '手机快没电了'],
    away: ['我在上班，不知道家里怎样', '我还没到家'],
    noCar: ['没有车，走不了', '开不出去'],
    sep: '，',
  },
  vi: {
    dmg: {
      hurricane: [
        ['không bị hư hại', 'nhà không sao', 'chỉ có cành cây rơi trong sân'],
        ['bay mất vài miếng ngói', 'hàng rào đổ, cửa sổ nứt', 'mái nhà hư nhẹ'],
        ['mất một phần mái, nước vào nhà', 'cây lớn đổ xuyên mái', 'nước trong nhà ngập khoảng 30 phân'],
        ['nhà bị phá hủy hoàn toàn', 'mất mái, tường sập', 'nước ngập tới trần, không ở được'],
      ],
      earthquake: [
        ['không bị hư hại', 'đồ đạc rơi nhưng nhà không sao', 'mọi thứ có vẻ ổn'],
        ['tường bị nứt', 'ống khói bị nứt', 'cửa kính và chén bát vỡ hết'],
        ['ống khói rơi xuyên mái', 'nứt lớn, cửa không đóng được', 'một phần trần nhà sập'],
        ['nhà bị lệch khỏi móng', 'tòa nhà bị sập', 'nhà bị dán thẻ đỏ, không vào được'],
      ],
    },
    vague: ['nhà cửa bừa bộn lắm', 'không biết hư nặng không, tối quá', 'chắc có hư hại'],
    safe: ['chúng tôi ổn', 'mọi người đều an toàn', 'ở đây ổn cả'],
    help: ['cần giúp đỡ', 'làm ơn gửi người tới', 'có ai tới xem giúp không'],
    helpUrgent: ['bị kẹt, xin cứu giúp', 'cần giúp ngay', 'nước đang dâng, cứu với'],
    quakeUrgent: ['bị kẹt, xin cứu giúp', 'cần giúp ngay', 'có mùi gas, cần giúp'],
    medical: ['mẹ tôi phải thở oxy', 'cần điện cho máy CPAP', 'ba tôi cần lọc thận'],
    kids: ['các con ở với tôi', 'em bé không sao'],
    elder: ['bà tôi 85 tuổi không đi được', 'chồng tôi nằm liệt giường'],
    noPower: ['mất điện', 'điện thoại sắp hết pin'],
    away: ['tôi đang đi làm, không biết nhà ra sao', 'tôi chưa về tới nhà'],
    noCar: ['không có xe để đi', 'không chạy ra được'],
    sep: ', ',
  },
  tl: {
    dmg: {
      hurricane: [
        ['walang sira', 'ok lang ang bahay', 'mga sanga lang sa bakuran'],
        ['natanggal ang ilang shingles', 'bumagsak ang bakod, basag ang bintana', 'konting sira sa bubong'],
        ['nawala ang bahagi ng bubong, pumapasok ang tubig', 'tumama ang puno sa bubong', 'may tubig sa loob, isang talampakan'],
        ['wasak ang bahay', 'wala nang bubong, gumuho ang pader', 'hanggang kisame ang tubig'],
      ],
      earthquake: [
        ['walang sira', 'may nahulog pero ok ang bahay', 'mukhang ok naman lahat'],
        ['may bitak sa pader', 'may lamat ang tsimenea', 'basag ang mga bintana'],
        ['bumagsak ang tsimenea sa bubong', 'malalaking bitak, hindi sumasara ang pinto', 'bumagsak ang bahagi ng kisame'],
        ['umalis ang bahay sa pundasyon', 'gumuho ang gusali', 'red tag ang bahay, bawal pumasok'],
      ],
    },
    vague: ['magulo ang bahay', 'hindi ko alam gaano kalala, madilim', 'may sira yata'],
    safe: ['ok lang kami', 'ligtas kaming lahat', 'ayos lang dito'],
    help: ['kailangan namin ng tulong', 'pakipadala ng tao', 'may makakapunta ba dito'],
    helpUrgent: ['naipit kami, tulong po', 'kailangan ng tulong ngayon', 'tumataas ang tubig, tulong'],
    quakeUrgent: ['naipit kami, tulong po', 'kailangan ng tulong ngayon', 'amoy gas, tulong'],
    medical: ['naka-oxygen si nanay', 'kailangan ng kuryente para sa CPAP', 'kailangan ng dialysis ni tatay'],
    kids: ['kasama ko ang mga bata', 'ok ang baby'],
    elder: ['85 na si lola at hindi makalakad', 'nakaratay ang asawa ko'],
    noPower: ['walang kuryente', 'malapit nang ma-lowbat'],
    away: ['nasa trabaho ako, di ko alam ang bahay', 'hindi pa ako nakakauwi'],
    noCar: ['walang sasakyan', 'hindi makaalis'],
    sep: ', ',
  },
  ko: {
    dmg: {
      hurricane: [
        ['피해 없음', '집은 괜찮아요', '마당에 나뭇가지만 떨어졌어요'],
        ['지붕 기와 몇 장 날아감', '울타리 넘어지고 창문 금 감', '지붕 약간 손상'],
        ['지붕 일부 날아가서 물이 새요', '큰 나무가 지붕을 뚫었어요', '집 안에 물이 30센티 찼어요'],
        ['집이 완전히 부서졌어요', '지붕 없어지고 벽 무너짐', '물이 천장까지 차서 못 살아요'],
      ],
      earthquake: [
        ['피해 없음', '물건은 떨어졌지만 집은 괜찮아요', '다 괜찮아 보여요'],
        ['벽에 금이 갔어요', '굴뚝에 금 감', '창문이랑 그릇 다 깨졌어요'],
        ['굴뚝이 지붕을 뚫고 떨어짐', '금이 크게 가서 문이 안 닫혀요', '천장 일부 무너짐'],
        ['집이 기초에서 밀려났어요', '건물 붕괴', '빨간 딱지 붙어서 못 들어가요'],
      ],
    },
    vague: ['집이 엉망이에요', '얼마나 심한지 모르겠어요, 어두워요', '피해가 좀 있는 것 같아요'],
    safe: ['저희는 괜찮아요', '모두 안전해요', '여기는 다 괜찮아요'],
    help: ['도움이 필요해요', '사람 좀 보내주세요', '누가 좀 와서 봐주세요'],
    helpUrgent: ['갇혔어요 도와주세요', '지금 당장 도움 필요', '물이 차올라요 도와주세요'],
    quakeUrgent: ['갇혔어요 도와주세요', '지금 당장 도움 필요', '가스 냄새 나요 도와주세요'],
    medical: ['어머니가 산소 사용 중', 'CPAP 때문에 전기가 필요해요', '아버지 투석 필요'],
    kids: ['아이들 저랑 같이 있어요', '아기는 괜찮아요'],
    elder: ['할머니 85세라 못 걸으세요', '남편이 거동을 못해요'],
    noPower: ['정전됐어요', '배터리 거의 없어요'],
    away: ['회사에 있어서 집 상태 몰라요', '아직 집에 못 갔어요'],
    noCar: ['차가 없어서 못 나가요', '나갈 수가 없어요'],
    sep: ', ',
  },
};

/** Need phrases (not life safety) plus the life-safety medical cue and "we left the house". */
interface NeedBank {
  shelter: string[];
  water_food: string[];
  inspection: string[];
  other: string[];
  medication: string[];
  medicalUrgent: string[];
  displaced: string[];
}

const NEED_BANKS: Record<Lang, NeedBank> = {
  en: {
    shelter: ['we need a place to stay', 'cant stay in the house tonight'],
    water_food: ['we need water', 'running out of food and water'],
    inspection: ['can someone come look at the house', 'need an adjuster to check the damage'],
    other: ['please call me back', 'call me when you can'],
    medication: ['running low on my medication', 'need a refill of my meds'],
    medicalUrgent: ['mom is on oxygen and the power is out, need help now', 'my dad cant breathe, please send help'],
    displaced: ['we left the house, staying with family', 'we are at a shelter now'],
  },
  es: {
    shelter: ['necesitamos un lugar donde quedarnos', 'no podemos quedarnos en la casa esta noche'],
    water_food: ['necesitamos agua', 'se nos acaba la comida y el agua'],
    inspection: ['¿pueden venir a revisar la casa?', 'necesito un ajustador para ver los daños'],
    other: ['por favor llámenme', 'llámenme cuando puedan'],
    medication: ['se me acaban las medicinas', 'necesito resurtir mis medicamentos'],
    medicalUrgent: ['mi mamá usa oxígeno y no hay luz, ayuda ya', 'mi papá no puede respirar, manden ayuda'],
    displaced: ['salimos de la casa, estamos con familia', 'estamos en un refugio'],
  },
  zh: {
    shelter: ['我们需要地方住', '今晚没法住在家里'],
    water_food: ['我们需要水', '吃的和水快没了'],
    inspection: ['能派人来看看房子吗', '需要理赔员来查看损失'],
    other: ['请给我回电话', '方便时给我打电话'],
    medication: ['我的药快吃完了', '需要补开药'],
    medicalUrgent: ['妈妈在用氧气机，停电了，马上需要帮助', '我爸喘不上气，快派人来'],
    displaced: ['我们已经离开家，住在亲戚家', '我们现在在避难所'],
  },
  vi: {
    shelter: ['chúng tôi cần chỗ ở', 'tối nay không ở nhà được'],
    water_food: ['chúng tôi cần nước', 'sắp hết đồ ăn và nước'],
    inspection: ['có thể cử người đến xem nhà không', 'cần người giám định đến xem thiệt hại'],
    other: ['vui lòng gọi lại cho tôi', 'khi nào rảnh gọi tôi nhé'],
    medication: ['tôi sắp hết thuốc', 'cần mua thêm thuốc'],
    medicalUrgent: ['mẹ tôi đang thở oxy mà mất điện, cần giúp ngay', 'bố tôi khó thở, xin gửi người đến'],
    displaced: ['chúng tôi đã rời nhà, đang ở nhà người thân', 'chúng tôi đang ở nơi tạm trú'],
  },
  tl: {
    shelter: ['kailangan namin ng matutuluyan', 'hindi kami makakatulog sa bahay ngayong gabi'],
    water_food: ['kailangan namin ng tubig', 'nauubos na ang pagkain at tubig'],
    inspection: ['pwede bang may pumunta para tingnan ang bahay', 'kailangan ng adjuster para tingnan ang sira'],
    other: ['pakitawagan po ako', 'tawagan niyo ako pag may oras'],
    medication: ['paubos na ang gamot ko', 'kailangan ko ng refill ng gamot'],
    medicalUrgent: ['naka-oxygen si nanay at walang kuryente, tulong agad', 'hindi makahinga si tatay, magpadala ng tulong'],
    displaced: ['umalis na kami sa bahay, nasa kamag-anak kami', 'nasa evacuation center kami ngayon'],
  },
  ko: {
    shelter: ['지낼 곳이 필요해요', '오늘 밤 집에 못 있어요'],
    water_food: ['물이 필요해요', '음식이랑 물이 거의 없어요'],
    inspection: ['누가 와서 집 좀 봐주실 수 있나요', '손해사정인이 피해를 확인해야 해요'],
    other: ['전화 부탁드려요', '시간 되실 때 전화 주세요'],
    medication: ['약이 거의 떨어졌어요', '약을 다시 받아야 해요'],
    medicalUrgent: ['어머니가 산소 쓰시는데 정전이에요, 지금 도와주세요', '아버지가 숨을 못 쉬어요, 도와주세요'],
    displaced: ['집에서 나와서 친척 집에 있어요', '지금 대피소에 있어요'],
  },
};

export interface ReplyContext {
  hh: Household;
  safety: 'safe' | 'needs_help';
  /** label damage; null = the person cannot see the house */
  damage: Damage | null;
  lifeSafety: boolean;
  needs: Need[];
  /** where the person is (truth) */
  location: Whereabouts;
  hazardType: HazardType;
  outagePct: number;
  floodFt: number;
}

/** Language the household texts back in: limited-English households always use their language;
 *  bilingual households use it 45% of the time (assumption); languages without templates fall back to English. */
export function replyLanguage(rng: Rng, hh: Household): Lang {
  const lang = hh.primaryLanguage ?? 'en';
  const has = (TEXT_LANGS as readonly string[]).includes(lang);
  if (lang === 'en' || !has) return 'en';
  if (hh.limitedEnglish) return lang as Lang;
  return rng.chance(0.45) ? (lang as Lang) : 'en';
}

function needPhrase(rng: Rng, b: Bank, n: NeedBank, need: Need): string {
  switch (need) {
    case 'medical': return rng.pick(n.medication); // not the oxygen / CPAP bank: that reads as life safety
    case 'power_for_device': return rng.pick(b.medical); // only reached from life-safety replies
    case 'transport': return rng.pick(b.noCar);
    case 'shelter': return rng.pick(n.shelter);
    case 'water_food': return rng.pick(n.water_food);
    case 'inspection': return rng.pick(n.inspection);
    default: return rng.pick(n.other);
  }
}

/** Render the labels as a short text. Returns what the text conveys: damage (null if the house is not described)
 *  and the needs it states (the event uses these, so text and labels agree). */
export function replyText(rng: Rng, lang: Lang, c: ReplyContext): { text: string; damage: Damage | null; needs: Need[] } {
  const b = BANKS[lang];
  const n = NEED_BANKS[lang];
  const parts: string[] = [];
  const said: Need[] = [];
  let damage = c.damage;
  const home = c.location === 'home';
  // Whereabouts first: people and the house are separate.
  if (c.location === 'away') parts.push(rng.pick(b.away));
  else if (c.location === 'displaced') parts.push(rng.pick(n.displaced));
  if (damage !== null) {
    const r = rng.float();
    // Vague phrases ("not sure how bad, it's dark") only from people at home.
    if (home && damage >= 1 && damage <= 2 && r < 0.15) {
      parts.push(b.vague[1]!); // "not sure how bad": the text does not tell the damage
      damage = null;
    } else if (home && damage >= 1 && damage <= 2 && r < 0.3) {
      parts.push(rng.pick([b.vague[0]!, b.vague[2]!])); // vague but some damage: label kept (ambiguous 1 vs 2)
    } else if (damage === 0 && r < 0.4) {
      damage = null; // only "we are ok": the house is not described
    } else {
      parts.push(rng.pick(b.dmg[c.hazardType][damage]));
    }
  }
  if (c.lifeSafety) {
    if (c.hh.medicalDevice && c.outagePct > 40 && rng.chance(0.7)) {
      parts.push(rng.pick(n.medicalUrgent));
      said.push('power_for_device');
    }
    else if (rng.chance(0.65)) parts.push(rng.pick(c.hazardType === 'earthquake' ? b.quakeUrgent : b.helpUrgent));
    else parts.push(rng.pick(b.help)); // generic plea: life safety by policy
    if ((c.hh.age75 || c.hh.disability) && rng.chance(0.5)) parts.push(rng.pick(b.elder));
  } else {
    if (c.safety === 'safe' && rng.chance(0.7)) parts.push(rng.pick(b.safe));
    for (const need of c.needs) {
      if (need === 'power_for_device') continue;
      parts.push(needPhrase(rng, b, n, need));
      said.push(need);
    }
  }
  if (c.hh.childrenUnder18 && rng.chance(0.15)) parts.push(rng.pick(b.kids));
  if (c.outagePct > 40 && rng.chance(0.35)) parts.push(rng.pick(b.noPower));
  if (parts.length === 0) parts.push(rng.pick(b.safe));
  let text = parts.join(b.sep);
  if (lang !== 'zh' && lang !== 'ko' && rng.chance(0.3)) text = text.charAt(0).toUpperCase() + text.slice(1);
  if (rng.chance(0.25)) text += lang === 'zh' ? '。' : '.';
  return { text, damage, needs: said };
}
