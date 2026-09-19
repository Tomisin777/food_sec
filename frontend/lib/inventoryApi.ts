import { DistributionModel, OrderItem, StockBand } from '@/lib/estimator';

export interface CheckInResponse {
  status: string;
  household_size: number;
  distribution_model: DistributionModel;
  estimated_lbs: number;
  depletions: Array<{
    category_id?: number;
    category_name: string;
    category_emoji?: string;
    depleted: number;
    remaining_qty: number;
    band: StockBand;
    previous_band?: string;
    confidence: number;
    source: string;
  }>;
  families_served_today: number;
  people_served_today: number;
}

export interface ShelfResponse {
  pantry_id: string;
  name: string;
  distribution_model: DistributionModel;
  items: Array<{
    category_id?: number;
    category_name: string;
    category_emoji?: string;
    band: StockBand | string;
    estimated_qty?: number | null;
    confidence?: number | null;
    source?: string | null;
    minutes_ago?: number | null;
    lbs_per_person?: number | null;
  }>;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.detail || data.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function postCheckIn(
  pantryId: string,
  householdSize: number,
  orderItems?: OrderItem[]
): Promise<CheckInResponse> {
  const res = await fetch('/api/inventory/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pantry_id: pantryId,
      household_size: householdSize,
      order_items: orderItems,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function postCorrection(
  pantryId: string,
  corrections: Array<{ category_id?: number; category_name?: string; band: StockBand; estimated_qty?: number | null }>
) {
  const res = await fetch('/api/inventory/correction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry_id: pantryId, corrections }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchToday(pantryId: string) {
  const res = await fetch(`/api/inventory/${pantryId}/today`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{
    check_in_count: number;
    households_served?: number;
    people_served?: number;
    total_households?: number;
  }>;
}

export async function fetchShelf(pantryId: string): Promise<ShelfResponse> {
  const res = await fetch(`/api/inventory/${pantryId}/shelf`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function patchDistribution(pantryId: string, model: DistributionModel) {
  const res = await fetch(`/api/inventory/${pantryId}/distribution`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distribution_model: model }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export function reportUrl(pantryId: string, year: number, month: number) {
  return `/api/inventory/${pantryId}/report?year=${year}&month=${month}`;
}
