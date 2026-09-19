/**
 * Server-side operator state for the volunteer portal when FastAPI/Postgres
 * is not running. Seeded from the static Baltimore pantry dataset.
 */
import { BALTIMORE_PANTRIES, Pantry } from '@/lib/pantryData';
import {
  DistributionModel,
  ShelfSnapshot,
  estimateCheckin,
  lbsPerPersonFor,
  snapCorrections,
  qtyFromBand,
  OrderItem,
} from '@/lib/estimator';
import fs from 'node:fs';
import path from 'node:path';

const STORE_PATH = path.join('/tmp', 'pantrypulse-operator-state.json');

export interface StoredCheckIn {
  time: string;
  household_size: number;
  estimated_lbs: number;
  distribution_model: DistributionModel;
  items: Array<{ category_id?: number; category_name?: string; depleted: number }>;
}

export interface PantryOperatorState {
  pantry_id: string;
  name: string;
  distribution_model: DistributionModel;
  shelf: ShelfSnapshot[];
  check_ins: StoredCheckIn[];
}

interface RootState {
  pantries: Record<string, PantryOperatorState>;
}

const CATEGORY_IDS: Record<string, number> = {
  produce: 1,
  protein: 2,
  dairy: 3,
  grains: 4,
  diapers: 5,
  hygiene: 6,
  'canned goods': 7,
  'halal items': 8,
  'baby essentials': 9,
};

function categoryIdFor(name: string): number | undefined {
  const key = name.trim().toLowerCase();
  if (key in CATEGORY_IDS) return CATEGORY_IDS[key];
  for (const [needle, id] of Object.entries(CATEGORY_IDS)) {
    if (key.includes(needle)) return id;
  }
  return undefined;
}

function shelfFromPantry(pantry: Pantry): ShelfSnapshot[] {
  return (pantry.shelf_items || []).map((item) => ({
    category_id: categoryIdFor(item.category_name),
    category_name: item.category_name,
    category_emoji: item.category_emoji,
    estimated_qty: qtyFromBand(item.band),
    band: item.band,
    lbs_per_person: lbsPerPersonFor(item.category_name),
    source: 'manual',
    confidence: item.confidence ?? 0.85,
    minutes_ago: item.minutes_ago ?? 0,
  }));
}

function seedCheckIns(pantry: Pantry, model: DistributionModel): StoredCheckIn[] {
  // Give the demo TEFAP export something to summarize for the current month.
  const sizes = pantry.name.toLowerCase().includes('northside')
    ? [3, 2, 5, 1, 4, 3, 2, 6, 2, 3, 4, 1, 2, 3, 5, 2, 4, 3, 1, 2, 3, 2, 4]
    : [2, 3, 4, 1, 2];
  const now = Date.now();
  return sizes.map((household_size, idx) => {
    const estimate = estimateCheckin({
      distributionModel: model,
      householdSize: household_size,
      shelfRows: shelfFromPantry(pantry),
    });
    return {
      time: new Date(now - (sizes.length - idx) * 60 * 60 * 1000).toISOString(),
      household_size,
      estimated_lbs: estimate.estimated_lbs,
      distribution_model: model,
      items: estimate.depletions
        .filter((d) => d.depleted > 0)
        .map((d) => ({
          category_id: d.category_id,
          category_name: d.category_name,
          depleted: d.depleted,
        })),
    };
  });
}

function seedPantry(pantry: Pantry): PantryOperatorState {
  const model = pantry.distribution_model || 'client_choice';
  return {
    pantry_id: pantry.id,
    name: pantry.name,
    distribution_model: model,
    shelf: shelfFromPantry(pantry),
    check_ins: seedCheckIns(pantry, model),
  };
}

let memory: RootState | null = null;

function loadState(): RootState {
  if (memory) return memory;
  try {
    if (fs.existsSync(STORE_PATH)) {
      memory = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as RootState;
      return memory;
    }
  } catch {
    // fall through to seed
  }
  memory = { pantries: {} };
  for (const pantry of BALTIMORE_PANTRIES) {
    memory.pantries[pantry.id] = seedPantry(pantry);
  }
  persist();
  return memory;
}

function persist() {
  if (!memory) return;
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(memory));
  } catch {
    // demo store is best-effort
  }
}

function ensurePantry(pantryId: string, name?: string, model?: DistributionModel): PantryOperatorState {
  const state = loadState();
  if (!state.pantries[pantryId]) {
    const known = BALTIMORE_PANTRIES.find((p) => p.id === pantryId);
    state.pantries[pantryId] = known
      ? seedPantry(known)
      : {
          pantry_id: pantryId,
          name: name || 'Community Pantry',
          distribution_model: model || 'client_choice',
          shelf: shelfFromPantry({
            ...(BALTIMORE_PANTRIES[0] as Pantry),
            id: pantryId,
            name: name || 'Community Pantry',
            distribution_model: model || 'client_choice',
          }),
          check_ins: [],
        };
    persist();
  }
  return state.pantries[pantryId];
}

export function getPantryState(pantryId: string): PantryOperatorState {
  return ensurePantry(pantryId);
}

export function setDistributionModel(pantryId: string, model: DistributionModel): PantryOperatorState {
  const pantry = ensurePantry(pantryId);
  pantry.distribution_model = model;
  persist();
  return pantry;
}

export function recordCheckIn(
  pantryId: string,
  householdSize: number,
  orderItems?: OrderItem[] | null
): {
  pantry: PantryOperatorState;
  estimate: ReturnType<typeof estimateCheckin>;
  families_served_today: number;
  people_served_today: number;
} {
  const pantry = ensurePantry(pantryId);
  const estimate = estimateCheckin({
    distributionModel: pantry.distribution_model,
    householdSize,
    shelfRows: pantry.shelf,
    orderItems,
  });

  pantry.check_ins.push({
    time: new Date().toISOString(),
    household_size: estimate.household_size,
    estimated_lbs: estimate.estimated_lbs,
    distribution_model: estimate.distribution_model,
    items: estimate.depletions
      .filter((d) => d.depleted > 0)
      .map((d) => ({
        category_id: d.category_id,
        category_name: d.category_name,
        depleted: d.depleted,
      })),
  });

  pantry.shelf = estimate.depletions.map((d) => ({
    category_id: d.category_id,
    category_name: d.category_name,
    category_emoji: d.category_emoji,
    estimated_qty: d.remaining_qty,
    band: d.band,
    lbs_per_person: d.lbs_per_person,
    source: 'prediction',
    confidence: d.confidence,
    minutes_ago: 0,
  }));
  persist();

  const today = new Date().toISOString().slice(0, 10);
  const todays = pantry.check_ins.filter((c) => c.time.slice(0, 10) === today);
  return {
    pantry,
    estimate,
    families_served_today: todays.length,
    people_served_today: todays.reduce((sum, c) => sum + c.household_size, 0),
  };
}

export function recordCorrection(
  pantryId: string,
  corrections: Array<{ category_id?: number; category_name?: string; band: string; estimated_qty?: number | null }>
): PantryOperatorState {
  const pantry = ensurePantry(pantryId);
  const snapped = snapCorrections(corrections, pantry.shelf);
  pantry.shelf = pantry.shelf.map((row) => {
    const match = snapped.find(
      (s) =>
        (s.category_id != null && s.category_id === row.category_id) ||
        (s.category_name && s.category_name.toLowerCase() === row.category_name.toLowerCase())
    );
    if (!match) return row;
    return {
      ...row,
      band: match.band,
      estimated_qty: match.estimated_qty,
      source: 'volunteer_correction',
      confidence: 1.0,
      minutes_ago: 0,
    };
  });
  persist();
  return pantry;
}

export function todayStats(pantryId: string) {
  const pantry = ensurePantry(pantryId);
  const today = new Date().toISOString().slice(0, 10);
  const todays = pantry.check_ins.filter((c) => c.time.slice(0, 10) === today);
  return {
    check_in_count: todays.length,
    households_served: todays.length,
    total_households: todays.reduce((sum, c) => sum + c.household_size, 0),
    people_served: todays.reduce((sum, c) => sum + c.household_size, 0),
  };
}

export function monthCheckIns(pantryId: string, year: number, month: number): StoredCheckIn[] {
  const pantry = ensurePantry(pantryId);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return pantry.check_ins.filter((c) => c.time.startsWith(prefix));
}
