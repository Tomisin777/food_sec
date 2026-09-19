import { Pantry, ShelfItem } from '@/lib/pantryData';
import { StockBand } from '@/lib/estimator';

export const SHELF_OVERLAY_KEY = 'pantrypulse:shelf-overlay';
export const DISTRIBUTION_OVERLAY_KEY = 'pantrypulse:distribution-overlay';
export const SHELF_UPDATED_EVENT = 'pantrypulse-shelf-updated';

export interface OverlayShelfItem {
  category_name: string;
  category_emoji?: string;
  band: StockBand;
  estimated_qty?: number;
  confidence?: number;
  source?: string;
  minutes_ago?: number;
}

export type ShelfOverlay = Record<string, OverlayShelfItem[]>;
export type DistributionOverlay = Record<string, 'pre_packed' | 'list' | 'client_choice'>;

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readShelfOverlay(): ShelfOverlay {
  return readJson<ShelfOverlay>(SHELF_OVERLAY_KEY, {});
}

export function readDistributionOverlay(): DistributionOverlay {
  return readJson<DistributionOverlay>(DISTRIBUTION_OVERLAY_KEY, {});
}

export function writeShelfOverlay(pantryId: string, items: OverlayShelfItem[]) {
  if (typeof window === 'undefined') return;
  const overlay = readShelfOverlay();
  overlay[pantryId] = items.map((item) => ({ ...item, minutes_ago: 0 }));
  window.localStorage.setItem(SHELF_OVERLAY_KEY, JSON.stringify(overlay));
  window.dispatchEvent(new Event(SHELF_UPDATED_EVENT));
}

export function writeDistributionOverlay(pantryId: string, model: 'pre_packed' | 'list' | 'client_choice') {
  if (typeof window === 'undefined') return;
  const overlay = readDistributionOverlay();
  overlay[pantryId] = model;
  window.localStorage.setItem(DISTRIBUTION_OVERLAY_KEY, JSON.stringify(overlay));
  window.dispatchEvent(new Event(SHELF_UPDATED_EVENT));
}

export function applyOverlays(pantries: Pantry[]): Pantry[] {
  const shelfOverlay = readShelfOverlay();
  const distOverlay = readDistributionOverlay();
  return pantries.map((pantry) => {
    const overlayItems = shelfOverlay[pantry.id];
    const model = distOverlay[pantry.id];
    if (!overlayItems && !model) return pantry;

    const mergedItems: ShelfItem[] = overlayItems
      ? overlayItems.map((item) => {
          const existing = pantry.shelf_items.find(
            (s) => s.category_name.toLowerCase() === item.category_name.toLowerCase()
          );
          return {
            category_name: item.category_name,
            category_emoji: item.category_emoji || existing?.category_emoji || '📦',
            band: item.band,
            minutes_ago: item.minutes_ago ?? 0,
            confidence: item.confidence ?? 1,
            estimated_qty: item.estimated_qty,
            source: item.source,
          };
        })
      : pantry.shelf_items;

    return {
      ...pantry,
      distribution_model: model || pantry.distribution_model,
      shelf_items: mergedItems,
    };
  });
}
