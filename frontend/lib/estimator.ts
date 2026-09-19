export type DistributionModel = 'pre_packed' | 'list' | 'client_choice';
export type StockBand = 'plenty' | 'low' | 'out';

export const PLENTY_THRESHOLD = 20;
export const LOW_THRESHOLD = 5;

export const DEFAULT_LBS_PER_PERSON: Record<string, number> = {
  produce: 2.0,
  protein: 1.5,
  dairy: 1.0,
  grains: 1.5,
  diapers: 0.5,
  hygiene: 0.3,
  'canned goods': 2.0,
  'halal items': 1.5,
  halal: 1.5,
};

export const BAND_SNAP_QTY: Record<StockBand, number> = {
  plenty: 25,
  low: 12,
  out: 0,
};

const PREDICTION_CONFIDENCE_AFTER_TRUTH = 0.8;
const PREDICTION_CONFIDENCE_DECAY = 0.9;
const PREDICTION_CONFIDENCE_FLOOR = 0.4;

export interface ShelfSnapshot {
  category_id?: number;
  category_name: string;
  category_emoji?: string;
  estimated_qty?: number | null;
  band?: StockBand | string | null;
  lbs_per_person?: number | null;
  source?: string | null;
  confidence?: number | null;
  minutes_ago?: number | null;
}

export interface OrderItem {
  category_id?: number;
  category_name?: string;
  quantity: number;
}

export interface Depletion {
  category_id?: number;
  category_name: string;
  category_emoji: string;
  depleted: number;
  previous_qty: number;
  remaining_qty: number;
  band: StockBand;
  previous_band: string;
  confidence: number;
  source: 'prediction';
  lbs_per_person: number;
}

export function qtyToBand(qty: number | null | undefined): StockBand {
  const remaining = qty == null ? 0 : Number(qty);
  if (remaining > PLENTY_THRESHOLD) return 'plenty';
  if (remaining >= LOW_THRESHOLD) return 'low';
  return 'out';
}

export function bandToQty(band: string, currentQty?: number | null): number {
  const normalized = (band || 'low').toLowerCase() as StockBand;
  const current = currentQty == null ? null : Number(currentQty);
  if (normalized === 'plenty') {
    if (current != null && current > PLENTY_THRESHOLD) return current;
    return BAND_SNAP_QTY.plenty;
  }
  if (normalized === 'low') {
    if (current != null && current >= LOW_THRESHOLD && current <= PLENTY_THRESHOLD) return current;
    return BAND_SNAP_QTY.low;
  }
  if (current != null && current < LOW_THRESHOLD) return Math.max(0, current);
  return BAND_SNAP_QTY.out;
}

export function nextPredictionConfidence(
  previousConfidence?: number | null,
  previousSource?: string | null
): number {
  const source = (previousSource || '').toLowerCase();
  if (['volunteer_correction', 'intake_photo', 'manual', 'client_feedback'].includes(source)) {
    return PREDICTION_CONFIDENCE_AFTER_TRUTH;
  }
  const prev = previousConfidence == null ? PREDICTION_CONFIDENCE_AFTER_TRUTH : Number(previousConfidence);
  return Math.round(Math.max(PREDICTION_CONFIDENCE_FLOOR, prev * PREDICTION_CONFIDENCE_DECAY) * 100) / 100;
}

export function normalizeCategoryKey(name: string): string {
  return (name || '').trim().toLowerCase();
}

export function lbsPerPersonFor(categoryName: string, explicit?: number | null): number {
  if (explicit != null) return Number(explicit);
  const key = normalizeCategoryKey(categoryName);
  if (key in DEFAULT_LBS_PER_PERSON) return DEFAULT_LBS_PER_PERSON[key];
  for (const [needle, rate] of Object.entries(DEFAULT_LBS_PER_PERSON)) {
    if (key.includes(needle)) return rate;
  }
  return 1;
}

export function depletionForCategory(opts: {
  distributionModel: string;
  householdSize: number;
  lbsPerPerson: number;
  orderedQty?: number | null;
}): number {
  const model = (opts.distributionModel || 'client_choice').toLowerCase();
  const size = Math.max(1, Number(opts.householdSize) || 1);
  const rate = Number(opts.lbsPerPerson);
  if (model === 'pre_packed') return Math.round(rate * 100) / 100;
  if (model === 'list' && opts.orderedQty != null) {
    return Math.round(Math.max(0, Number(opts.orderedQty)) * 100) / 100;
  }
  return Math.round(size * rate * 100) / 100;
}

export function applyDepletion(currentQty: number | null | undefined, depleted: number): number {
  const remaining = currentQty == null ? 0 : Number(currentQty);
  return Math.round(Math.max(0, remaining - Math.max(0, depleted)) * 100) / 100;
}

export function qtyFromBand(band?: string | null, estimatedQty?: number | null): number {
  if (estimatedQty != null) return Number(estimatedQty);
  const key = (band || 'low').toLowerCase() as StockBand;
  return BAND_SNAP_QTY[key] ?? 12;
}

export function estimateCheckin(opts: {
  distributionModel: string;
  householdSize: number;
  shelfRows: ShelfSnapshot[];
  orderItems?: OrderItem[] | null;
}): {
  distribution_model: DistributionModel;
  household_size: number;
  estimated_lbs: number;
  depletions: Depletion[];
} {
  const ordersById = new Map<number, number>();
  const ordersByName = new Map<string, number>();
  for (const item of opts.orderItems || []) {
    if (item.quantity == null) continue;
    if (item.category_id != null) ordersById.set(item.category_id, Number(item.quantity));
    if (item.category_name) ordersByName.set(normalizeCategoryKey(item.category_name), Number(item.quantity));
  }

  const hasExplicitOrder = ordersById.size > 0 || ordersByName.size > 0;
  const model = (opts.distributionModel || 'client_choice').toLowerCase() as DistributionModel;
  const depletions: Depletion[] = [];
  let estimatedLbs = 0;

  for (const row of opts.shelfRows) {
    const name = row.category_name || '';
    const rate = lbsPerPersonFor(name, row.lbs_per_person);
    let ordered: number | null = null;
    if (row.category_id != null && ordersById.has(row.category_id)) {
      ordered = ordersById.get(row.category_id)!;
    } else if (ordersByName.has(normalizeCategoryKey(name))) {
      ordered = ordersByName.get(normalizeCategoryKey(name))!;
    }

    let depleted = depletionForCategory({
      distributionModel: model,
      householdSize: opts.householdSize,
      lbsPerPerson: rate,
      orderedQty: ordered,
    });
    if (model === 'list' && hasExplicitOrder && ordered == null) {
      depleted = 0;
    }

    const currentQty = qtyFromBand(row.band, row.estimated_qty);
    const remaining = applyDepletion(currentQty, depleted);
    const band = qtyToBand(remaining);
    estimatedLbs += depleted;
    depletions.push({
      category_id: row.category_id,
      category_name: name,
      category_emoji: row.category_emoji || '📦',
      depleted,
      previous_qty: currentQty,
      remaining_qty: remaining,
      band,
      previous_band: String(row.band || qtyToBand(currentQty)),
      confidence: nextPredictionConfidence(row.confidence, row.source),
      source: 'prediction',
      lbs_per_person: rate,
    });
  }

  return {
    distribution_model: model,
    household_size: Math.max(1, Number(opts.householdSize) || 1),
    estimated_lbs: Math.round(estimatedLbs * 100) / 100,
    depletions,
  };
}

export function snapCorrections(
  corrections: Array<{ category_id?: number; category_name?: string; band: string; estimated_qty?: number | null; category_emoji?: string }>,
  shelfRows: ShelfSnapshot[]
) {
  const byId = new Map<number, ShelfSnapshot>();
  const byName = new Map<string, ShelfSnapshot>();
  for (const row of shelfRows) {
    if (row.category_id != null) byId.set(row.category_id, row);
    byName.set(normalizeCategoryKey(row.category_name), row);
  }

  return corrections.map((correction) => {
    const row =
      (correction.category_id != null ? byId.get(correction.category_id) : undefined) ||
      byName.get(normalizeCategoryKey(correction.category_name || '')) ||
      {};
    const band = (correction.band || (row as ShelfSnapshot).band || 'low').toLowerCase() as StockBand;
    const currentQty = correction.estimated_qty ?? (row as ShelfSnapshot).estimated_qty;
    return {
      category_id: correction.category_id ?? (row as ShelfSnapshot).category_id,
      category_name: correction.category_name || (row as ShelfSnapshot).category_name,
      category_emoji: correction.category_emoji || (row as ShelfSnapshot).category_emoji || '📦',
      band,
      estimated_qty: bandToQty(band, currentQty),
      source: 'volunteer_correction' as const,
      confidence: 1.0,
    };
  });
}

export function defaultPackLbs(shelfRows: ShelfSnapshot[]): number {
  const total = shelfRows.reduce((sum, row) => sum + lbsPerPersonFor(row.category_name, row.lbs_per_person), 0);
  return Math.round(total * 100) / 100 || 10.3;
}
