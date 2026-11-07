// Short free-text SMS replies in the household's language, consistent with the structured
// (safety, damage) values of the same sms_reply event, with deliberate ambiguity.
// All texts are synthetic templates written for this simulator.

import type { Damage, HazardType, Household } from '../../shared/types.ts';
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

export interface ReplyContext {
  hh: Household;
  safety: 'safe' | 'needs_help';
  damage: Damage;
  hazardType: HazardType;
  outagePct: number;
  floodFt: number;
  awayNow: boolean;
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

export function replyText(rng: Rng, lang: Lang, c: ReplyContext): string {
  const b = BANKS[lang];
  const parts: string[] = [];
  if (c.awayNow && rng.chance(0.6)) parts.push(rng.pick(b.away));
  else if (c.damage >= 1 && c.damage <= 2 && rng.chance(0.2)) parts.push(rng.pick(b.vague)); // ambiguous
  else if (!(c.damage === 0 && rng.chance(0.4))) parts.push(rng.pick(b.dmg[c.hazardType][c.damage]));
  if (c.safety === 'needs_help') {
    const urgent = c.damage >= 2 || c.floodFt > 4;
    parts.push(rng.pick(urgent && rng.chance(0.6) ? (c.hazardType === 'earthquake' ? b.quakeUrgent : b.helpUrgent) : b.help));
    if (c.hh.medicalDevice && rng.chance(0.7)) parts.push(rng.pick(b.medical));
    else if ((c.hh.age75 || c.hh.disability) && rng.chance(0.6)) parts.push(rng.pick(b.elder));
    else if (c.hh.noVehicle && c.hazardType === 'hurricane' && rng.chance(0.5)) parts.push(rng.pick(b.noCar));
  } else {
    if (rng.chance(0.7)) parts.push(rng.pick(b.safe));
    if (c.hh.medicalDevice && c.outagePct > 50 && rng.chance(0.4)) parts.push(rng.pick(b.medical)); // safe but a need
  }
  if (c.hh.childrenUnder18 && rng.chance(0.15)) parts.push(rng.pick(b.kids));
  if (c.outagePct > 40 && rng.chance(0.35)) parts.push(rng.pick(b.noPower));
  if (parts.length === 0) parts.push(rng.pick(b.safe));
  let text = parts.join(b.sep);
  if (lang !== 'zh' && lang !== 'ko' && rng.chance(0.3)) text = text.charAt(0).toUpperCase() + text.slice(1);
  if (rng.chance(0.25)) text += lang === 'zh' ? '。' : '.';
  return text;
}
