/**
 * キーワードの表記ゆれ：モールが「同じ語」とみなすものを1つにまとめるための鍵
 *
 * 楽天RPP（同じとみなす → 1つ登録すればよい）：ひらがな／カタカナ、語順
 *          （別とみなす → それぞれ登録）：スペースの有無、スペルミス
 * Amazon 広告（同じとみなす）：ひらがな／カタカナ、単数／複数、略称、類似表現・翻訳、全角／半角
 *          （別とみなす）：スペースの有無、語順
 * ※ 2026-11 担当者の調べ。全角／半角は両モールとも同じ扱いにする（NFKC でそろえる）
 * ※ Amazon の略称・類似表現・翻訳（shampoo とシャンプーなど）は機械では判定できないので、まとめない
 */

/** カタカナ → ひらがな（長音「ー」はそのまま） */
export const toHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** 英単語の複数形を単数形に（Amazon 用。短い語・ss で終わる語はそのまま） */
const singular = (w: string) => {
  if (!/^[a-z]{4,}$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
};

/** モールが同じ語とみなすものが同じ値になる鍵 */
export function canonKw(mall: string, keyword: string): string {
  const base = toHira(keyword.normalize("NFKC").toLowerCase()).trim().split(/\s+/).filter(Boolean);
  if (mall === "rakuten") return [...base].sort().join(" ");      // 語順は問わない（スペースの有無は区別する）
  return base.map(singular).join(" ");                             // Amazon：語順・スペースの有無は区別する
}
