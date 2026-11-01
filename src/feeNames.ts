/**
 * Amazon が返す手数料・費目の名前を日本語に直す
 *
 * Amazon は FeeType / ChargeType / PromotionType を英語の識別子で返す。
 * 画面には日本語を出すが、Amazon のレポートと突き合わせられるよう
 * 元の名前も併記する（feeLabel は日本語だけを返し、元の名前は呼び出し側で出す）。
 *
 * 載っていない名前が出てきたら、そのまま英語で表示される。
 * 連携ステータスの履歴に出てくるので、気づいたらここに足す。
 */

const NAMES: Record<string, string> = {
  /* 販売にかかるもの */
  Commission: "販売手数料",
  RefundCommission: "返金処理手数料",
  VariableClosingFee: "カテゴリー成約料",
  FixedClosingFee: "成約料",
  PerItemFee: "基本成約料",
  Subscription: "月額登録料",
  HighVolumeListingFee: "大量出品手数料",
  DigitalServicesFee: "デジタルサービス料",
  SalesTaxCollectionFee: "税の徴収手数料",
  LowValueGoodsFee: "少額商品手数料",

  /* FBA（配送・保管） */
  FBAPerUnitFulfillmentFee: "FBA配送代行手数料",
  FBAPerOrderFulfillmentFee: "FBA配送代行手数料（注文単位）",
  FBAWeightBasedFee: "FBA重量手数料",
  FBATransportationFee: "FBA配送料",
  FBAInboundTransportationFee: "FBA納品時の配送料",
  FBAInboundTransportationProgramFee: "FBAパートナーキャリア料金",
  FBAInboundDefectFee: "納品不備手数料",
  FBAStorageFee: "在庫保管料",
  StorageFee: "在庫保管料",
  FBALongTermStorageFee: "長期在庫保管手数料",
  FBAOverageFee: "在庫保管超過手数料",
  FBADisposalFee: "所有権の放棄手数料",
  FBARemovalFee: "返送手数料",
  FBAInventoryPlacementServiceFee: "在庫保管オプション料",
  FBAFulfillmentCODFee: "代金引換手数料",
  FBACustomerReturnPerUnitFee: "返品処理手数料",

  /* 商品の準備サービス */
  LabelingFee: "ラベル貼付サービス料",
  PolybaggingFee: "袋詰めサービス料",
  BubblewrapFee: "緩衝材サービス料",
  OpaqueBaggingFee: "不透明袋詰めサービス料",
  TapingFee: "テープ貼付サービス料",

  /* 返金・取り消し */
  ShippingChargeback: "配送料の返金",
  GiftwrapChargeback: "ギフトラッピング料の返金",
  ShippingHB: "配送料の調整",

  /* 販促 */
  RunLightningDealFee: "特選タイムセール手数料",
  CouponRedemptionFee: "クーポン利用手数料",
  PromotionMetaDataDefinitionValue: "クーポン・プロモーション値引",
  Shipping: "配送料の値引",
  GenericPromotion: "プロモーション値引",

  /* 商品代金まわり（返金明細に出る） */
  Principal: "商品代金",
  Tax: "消費税",
  ShippingCharge: "配送料",
  ShippingTax: "配送料の消費税",
  GiftWrap: "ギフトラッピング料",
  GiftWrapTax: "ギフトラッピング料の消費税",
  Goodwill: "お詫びの返金",
  PointsGranted: "ポイント付与",
  RestockingFee: "返品手数料",
  ReturnShipping: "返送料",
  CODItemCharge: "代金引換手数料",

  /* 調整 */
  WAREHOUSE_DAMAGE: "倉庫内破損の補填",
  WAREHOUSE_LOST: "倉庫内紛失の補填",
  WAREHOUSE_DAMAGE_EXCEPTION: "倉庫内破損の補填（例外）",
  REVERSAL_REIMBURSEMENT: "補填の取り消し",
  COMPENSATED_CLAWBACK: "補填の返還",
  FREE_REPLACEMENT_REFUND_ITEMS: "無料交換品の返金",
  MISSING_FROM_INBOUND: "納品時の不足分の補填",
  INCORRECT_FEES_ITEMS: "手数料の誤りの調整",
};

/** 名前の先頭で判定するもの（Amazon が末尾に区分を付けて返すため） */
const PREFIXES: Array<[string, string]> = [
  ["MarketplaceFacilitatorTax-Principal", "マーケットプレイス税（商品代金分）"],
  ["MarketplaceFacilitatorTax-Shipping", "マーケットプレイス税（配送料分）"],
  ["MarketplaceFacilitatorTax", "マーケットプレイス税"],
  ["LowValueGoodsTax", "少額商品の税"],
  ["RenewedProgramFee", "Amazon整備済み品プログラム手数料"],
];

/** 英語の識別子を日本語にする。知らない名前はそのまま返す */
export function feeLabel(name: string): string {
  if (NAMES[name]) return NAMES[name];
  for (const [prefix, ja] of PREFIXES) {
    if (name.startsWith(prefix)) return ja;
  }
  return name;
}

/** 日本語に直せたかどうか。直せないものを画面で目立たせるために使う */
export function isKnownFee(name: string): boolean {
  return feeLabel(name) !== name;
}
