'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Users,
  Camera,
  CheckSquare,
  Mic,
  Plus,
  Minus,
  Check,
  ShieldCheck,
  Upload,
  Sparkles,
  Loader2,
  FileSpreadsheet,
  Package,
  ClipboardList,
  Store,
  Download,
} from 'lucide-react';
import { Pantry } from '@/lib/pantryData';
import CameraViewfinder from '@/components/CameraViewfinder';
import { DistributionModel, OrderItem, StockBand, lbsPerPersonFor } from '@/lib/estimator';
import {
  fetchShelf,
  fetchToday,
  patchDistribution,
  postCheckIn,
  postCorrection,
  reportUrl,
  ShelfResponse,
} from '@/lib/inventoryApi';
import { writeDistributionOverlay, writeShelfOverlay } from '@/lib/shelfSync';

interface VolunteerDashboardProps {
  activePantry?: Pantry | null;
  onExit?: () => void;
  onUpdateInventory?: (category: string, band: 'plenty' | 'low' | 'out') => void;
}

type Tab = 'checkin' | 'donations' | 'closing' | 'reports';

const DISTRIBUTION_OPTIONS: Array<{
  id: DistributionModel;
  title: string;
  blurb: string;
  icon: typeof Package;
}> = [
  {
    id: 'pre_packed',
    title: 'Pre-packed boxes',
    blurb: 'Outflow = 1 fixed pack per check-in, regardless of household size.',
    icon: Package,
  },
  {
    id: 'list',
    title: 'Pick from a list',
    blurb: 'Deduct the items they ordered. Defaults follow the allocation chart.',
    icon: ClipboardList,
  },
  {
    id: 'client_choice',
    title: 'Shop the shelves',
    blurb: 'Predict-and-correct: household size × lbs per person per category.',
    icon: Store,
  },
];

function overlayFromShelf(items: ShelfResponse['items'] | undefined) {
  return (items || []).map((item) => ({
    category_name: item.category_name,
    category_emoji: item.category_emoji,
    band: (item.band || 'low') as StockBand,
    estimated_qty: item.estimated_qty ?? undefined,
    confidence: item.confidence ?? undefined,
    source: item.source ?? undefined,
    minutes_ago: 0,
  }));
}

export default function VolunteerDashboard({ activePantry, onExit, onUpdateInventory }: VolunteerDashboardProps) {
  const pantryId = activePantry?.id || '';
  const [activeTab, setActiveTab] = useState<Tab>('checkin');
  const [familiesServed, setFamiliesServed] = useState(0);
  const [peopleServed, setPeopleServed] = useState(0);
  const [lastCheckinToast, setLastCheckinToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [distributionModel, setDistributionModel] = useState<DistributionModel>(
    activePantry?.distribution_model || 'client_choice'
  );
  const [shelf, setShelf] = useState<ShelfResponse['items']>(
    (activePantry?.shelf_items || []).map((item, idx) => ({
      category_id: idx + 1,
      category_name: item.category_name,
      category_emoji: item.category_emoji,
      band: item.band,
      estimated_qty: item.estimated_qty,
      confidence: item.confidence,
      source: item.source || 'manual',
      minutes_ago: item.minutes_ago,
      lbs_per_person: lbsPerPersonFor(item.category_name),
    }))
  );

  const [pendingListSize, setPendingListSize] = useState<number | null>(null);
  const [orderDraft, setOrderDraft] = useState<Record<string, number>>({});

  const [outAlerts, setOutAlerts] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showLiveCamera, setShowLiveCamera] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannedImagePreview, setScannedImagePreview] = useState<string | null>(null);
  const [donationCounts, setDonationCounts] = useState<{ [key: string]: { count: number; category: string } }>({
    'Canned green beans': { count: 4, category: 'Produce' },
    'Cereal box': { count: 2, category: 'Grains' },
    'Meat soup': { count: 3, category: 'Protein' },
  });
  const [donationsAddedNotice, setDonationsAddedNotice] = useState(false);

  const [closingGuesses, setClosingGuesses] = useState<Record<string, StockBand>>({});
  const [closingSaved, setClosingSaved] = useState(false);

  const now = new Date();
  const [reportYear, setReportYear] = useState(now.getFullYear());
  const [reportMonth, setReportMonth] = useState(now.getMonth() + 1);
  const [reportNotice, setReportNotice] = useState<string | null>(null);

  const publishShelf = useCallback(
    (items: ShelfResponse['items']) => {
      setShelf(items);
      if (pantryId) writeShelfOverlay(pantryId, overlayFromShelf(items));
    },
    [pantryId]
  );

  const refreshFromServer = useCallback(async () => {
    if (!pantryId) return;
    try {
      const [today, liveShelf] = await Promise.all([fetchToday(pantryId), fetchShelf(pantryId)]);
      setFamiliesServed(today.households_served ?? today.check_in_count ?? 0);
      setPeopleServed(today.people_served ?? today.total_households ?? 0);
      if (liveShelf.distribution_model) setDistributionModel(liveShelf.distribution_model);
      if (liveShelf.items?.length) {
        setShelf(liveShelf.items);
        writeShelfOverlay(pantryId, overlayFromShelf(liveShelf.items));
      }
    } catch (err) {
      console.warn('Operator store unavailable, using local pantry snapshot', err);
    }
  }, [pantryId]);

  useEffect(() => {
    refreshFromServer();
  }, [refreshFromServer]);

  useEffect(() => {
    const guesses: Record<string, StockBand> = {};
    shelf.forEach((item) => {
      guesses[item.category_name] = (item.band || 'low') as StockBand;
    });
    setClosingGuesses(guesses);
  }, [shelf]);

  const beginListOrder = (size: number) => {
    const draft: Record<string, number> = {};
    shelf.forEach((item) => {
      draft[item.category_name] = Number(
        (size * lbsPerPersonFor(item.category_name, item.lbs_per_person)).toFixed(1)
      );
    });
    setOrderDraft(draft);
    setPendingListSize(size);
  };

  const handleHouseholdTap = async (size: number, orderItems?: OrderItem[]) => {
    if (!pantryId || busy) return;
    if (distributionModel === 'list' && !orderItems) {
      beginListOrder(size);
      return;
    }
    setBusy(true);
    try {
      const result = await postCheckIn(pantryId, size, orderItems);
      setFamiliesServed(result.families_served_today);
      setPeopleServed(result.people_served_today);
      publishShelf(
        result.depletions.map((d) => ({
          category_id: d.category_id,
          category_name: d.category_name,
          category_emoji: d.category_emoji,
          band: d.band,
          estimated_qty: d.remaining_qty,
          confidence: d.confidence,
          source: d.source,
          minutes_ago: 0,
          lbs_per_person: lbsPerPersonFor(d.category_name),
        }))
      );
      const flipped = result.depletions.filter((d) => d.previous_band && d.previous_band !== d.band);
      const styleNote =
        result.distribution_model === 'pre_packed'
          ? `1 pre-packed box (−${result.estimated_lbs} lbs)`
          : result.distribution_model === 'list'
            ? `order logged (−${result.estimated_lbs} lbs)`
            : `${size} × allocation chart (−${result.estimated_lbs} lbs)`;
      const flipNote = flipped.length ? ` ${flipped.map((d) => `${d.category_name} → ${d.band}`).join(', ')}.` : '';
      setLastCheckinToast(`Household of ${size} checked in · ${styleNote}.${flipNote}`);
      setTimeout(() => setLastCheckinToast(null), 4000);
      setPendingListSize(null);
    } catch (err) {
      console.error(err);
      setLastCheckinToast('Check-in failed. Try again.');
      setTimeout(() => setLastCheckinToast(null), 3000);
    } finally {
      setBusy(false);
    }
  };

  const confirmListOrder = () => {
    if (pendingListSize == null) return;
    const items: OrderItem[] = Object.entries(orderDraft)
      .filter(([, qty]) => qty > 0)
      .map(([category_name, quantity]) => ({ category_name, quantity }));
    handleHouseholdTap(pendingListSize, items);
  };

  const handleDistributionChange = async (model: DistributionModel) => {
    setDistributionModel(model);
    if (pantryId) writeDistributionOverlay(pantryId, model);
    try {
      await patchDistribution(pantryId, model);
    } catch (err) {
      console.warn('Could not persist distribution model', err);
    }
  };

  const toggleRunOut = async (cat: string) => {
    const turningOut = !outAlerts.includes(cat);
    const nextBand: StockBand = turningOut ? 'out' : 'low';
    setOutAlerts(turningOut ? [...outAlerts, cat] : outAlerts.filter((c) => c !== cat));
    if (onUpdateInventory) onUpdateInventory(cat, nextBand);
    const nextShelf = shelf.map((item) =>
      item.category_name === cat
        ? { ...item, band: nextBand, estimated_qty: nextBand === 'out' ? 0 : 12, source: 'manual', confidence: 1, minutes_ago: 0 }
        : item
    );
    publishShelf(nextShelf);
    if (pantryId) {
      try {
        await postCorrection(pantryId, [{ category_name: cat, band: nextBand }]);
      } catch (err) {
        console.warn('Run-out flag persist failed', err);
      }
    }
  };

  const handleScanDonation = async (presetOrFile: string | File) => {
    setIsScanning(true);
    try {
      const formData = new FormData();
      if (typeof presetOrFile === 'string') {
        formData.append('preset', presetOrFile);
      } else {
        formData.append('image', presetOrFile);
        const reader = new FileReader();
        reader.onload = (e) => setScannedImagePreview(e.target?.result as string);
        reader.readAsDataURL(presetOrFile);
      }

      const res = await fetch('/api/scan-donation', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (data.items && Array.isArray(data.items)) {
        const newCounts: { [key: string]: { count: number; category: string } } = {};
        data.items.forEach((it: { name: string; count?: number; category?: string }) => {
          newCounts[it.name] = { count: it.count || 1, category: it.category || 'General' };
        });
        setDonationCounts(newCounts);
      }
    } catch (err) {
      console.error('Scan error:', err);
    } finally {
      setIsScanning(false);
    }
  };

  const handleApplyDonations = () => {
    setDonationsAddedNotice(true);
    Object.values(donationCounts).forEach(({ category }) => {
      if (onUpdateInventory && ['Produce', 'Protein', 'Dairy', 'Diapers', 'Grains'].includes(category)) {
        onUpdateInventory(category, 'plenty');
      }
    });
    const nextShelf = shelf.map((item) => {
      const added = Object.values(donationCounts).some(
        ({ category }) => category.toLowerCase() === item.category_name.toLowerCase()
      );
      if (!added) return item;
      const bump = Object.values(donationCounts)
        .filter(({ category }) => category.toLowerCase() === item.category_name.toLowerCase())
        .reduce((sum, row) => sum + row.count, 0);
      const qty = Math.max(21, (item.estimated_qty || 12) + bump);
      return { ...item, band: 'plenty' as StockBand, estimated_qty: qty, source: 'intake_photo', confidence: 0.95, minutes_ago: 0 };
    });
    publishShelf(nextShelf);
    setTimeout(() => setDonationsAddedNotice(false), 3000);
  };

  const handleSendClosingUpdate = async () => {
    if (!pantryId) return;
    setBusy(true);
    try {
      const corrections = Object.entries(closingGuesses).map(([category_name, band]) => {
        const current = shelf.find((s) => s.category_name === category_name);
        return { category_name, band, estimated_qty: current?.estimated_qty ?? null, category_id: current?.category_id };
      });
      const result = await postCorrection(pantryId, corrections);
      const updated = (result.updated || []).map(
        (row: { category_name?: string; band: StockBand; estimated_qty: number; confidence: number; source: string; category_id?: number }) => {
          const prev = shelf.find(
            (s) =>
              (row.category_id != null && s.category_id === row.category_id) ||
              (row.category_name && s.category_name.toLowerCase() === row.category_name.toLowerCase())
          );
          return {
            category_id: row.category_id ?? prev?.category_id,
            category_name: row.category_name || prev?.category_name || '',
            category_emoji: prev?.category_emoji,
            band: row.band,
            estimated_qty: row.estimated_qty,
            confidence: 1.0,
            source: 'volunteer_correction',
            minutes_ago: 0,
            lbs_per_person: prev?.lbs_per_person,
          };
        }
      );
      if (updated.length) publishShelf(updated);
      setClosingSaved(true);
      setTimeout(() => setClosingSaved(false), 3000);
    } catch (err) {
      console.error(err);
      setLastCheckinToast('Could not publish closing check.');
      setTimeout(() => setLastCheckinToast(null), 3000);
    } finally {
      setBusy(false);
    }
  };

  const handleExportReport = async () => {
    if (!pantryId) return;
    setReportNotice(null);
    try {
      const res = await fetch(reportUrl(pantryId, reportYear, reportMonth));
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tefap-report-${reportYear}-${String(reportMonth).padStart(2, '0')}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setReportNotice('CSV downloaded. Ready for Maryland Food Bank / TEFAP.');
    } catch (err) {
      console.error(err);
      setReportNotice('Could not generate the monthly report.');
    }
  };

  const monthOptions = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => i + 1);
  }, []);

  return (
    <div className="bg-[#f2f6f4] min-h-[85vh] text-slate-800 rounded-3xl border border-emerald-900/10 shadow-xl flex flex-col justify-between overflow-hidden max-w-2xl mx-auto">
      <div className="bg-white px-5 py-4 border-b border-emerald-900/10 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 bg-emerald-100/80 border border-emerald-200 px-2.5 py-0.5 rounded-full">
              Pantry View
            </span>
            <span className="text-xs text-slate-500 font-medium">Verified Operator Session</span>
          </div>
          <h2 className="text-xl font-bold text-emerald-950 mt-0.5">
            {activePantry?.name || 'Northside Family Pantry'}
          </h2>
          {activePantry?.neighborhood && (
            <span className="text-xs text-slate-400 font-medium">{activePantry.neighborhood}, Baltimore</span>
          )}
        </div>
        {onExit && (
          <button
            onClick={onExit}
            className="text-xs text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer"
          >
            ← Exit to Neighbor View
          </button>
        )}
      </div>

      <div className="p-5 md:p-6 flex-1 overflow-y-auto">
        {lastCheckinToast && (
          <div className="mb-4 bg-emerald-900 text-white px-4 py-2.5 rounded-2xl text-xs flex items-center justify-between shadow-lg">
            <span>{lastCheckinToast}</span>
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>
        )}

        {activeTab === 'checkin' && (
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="font-bold text-base text-emerald-950 mb-1">How do you give food out?</h3>
              <p className="text-xs text-slate-500 mb-3">
                Saved per pantry. Check-in depletion follows this model.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {DISTRIBUTION_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = distributionModel === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => handleDistributionChange(option.id)}
                      className={`text-left rounded-2xl border p-3 transition ${
                        selected
                          ? 'bg-emerald-900 text-white border-emerald-950 shadow-sm'
                          : 'bg-white border-slate-200 hover:border-emerald-600 text-slate-800'
                      }`}
                    >
                      <Icon className={`w-4 h-4 mb-1.5 ${selected ? 'text-emerald-200' : 'text-emerald-700'}`} />
                      <span className="block text-xs font-bold">{option.title}</span>
                      <span className={`block text-[11px] mt-1 leading-snug ${selected ? 'text-emerald-100' : 'text-slate-500'}`}>
                        {option.blurb}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="bg-[#064e3b] text-white rounded-3xl p-5 shadow-sm flex items-center justify-between">
              <div>
                <p className="text-xs text-emerald-200 font-medium">Families served today</p>
                <p className="text-4xl font-extrabold tracking-tight mt-1">{familiesServed}</p>
                <p className="text-[11px] text-emerald-200/80 mt-1">{peopleServed} neighbors</p>
              </div>
              <p className="text-xs text-emerald-200/80 max-w-[160px] text-right">
                Tap a number each time a family checks in.
              </p>
            </div>

            {pendingListSize != null ? (
              <div className="bg-white rounded-2xl p-4 border border-emerald-900/10 flex flex-col gap-3">
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <h4 className="font-bold text-sm text-emerald-950">What did household of {pendingListSize} take?</h4>
                    <p className="text-xs text-slate-500">Adjust pounds, then confirm. Empty categories are skipped.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingListSize(null)}
                    className="text-xs font-semibold text-slate-500 hover:text-slate-800"
                  >
                    Cancel
                  </button>
                </div>
                {shelf.map((item) => (
                  <div key={item.category_name} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                    <span className="text-sm font-medium text-slate-800">
                      {item.category_emoji} {item.category_name}
                    </span>
                    <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          setOrderDraft((prev) => ({
                            ...prev,
                            [item.category_name]: Math.max(0, Number((prev[item.category_name] - 0.5).toFixed(1))),
                          }))
                        }
                        className="p-1 hover:bg-slate-200 rounded-lg text-slate-600"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="font-bold text-sm w-10 text-center">{orderDraft[item.category_name] ?? 0}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setOrderDraft((prev) => ({
                            ...prev,
                            [item.category_name]: Number(((prev[item.category_name] || 0) + 0.5).toFixed(1)),
                          }))
                        }
                        className="p-1 hover:bg-slate-200 rounded-lg text-slate-600"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={confirmListOrder}
                  className="bg-[#064e3b] text-white py-3 rounded-2xl font-bold text-sm hover:bg-[#043d2e] disabled:opacity-50"
                >
                  Deduct this order
                </button>
              </div>
            ) : (
              <div>
                <h3 className="font-bold text-base text-emerald-950 mb-1">Tap the household size</h3>
                <p className="text-xs text-slate-500 mb-3">No names. Just the number of people in the household.</p>
                <div className="grid grid-cols-4 gap-3">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
                    <button
                      key={size}
                      disabled={busy}
                      onClick={() => handleHouseholdTap(size === 8 ? 8 : size)}
                      className="bg-white hover:bg-emerald-50 active:bg-emerald-100 border-2 border-slate-200 hover:border-emerald-600 rounded-2xl py-4 flex flex-col items-center justify-center font-bold text-2xl text-slate-800 shadow-sm transition active:scale-95 disabled:opacity-50"
                    >
                      {size === 8 ? '8+' : size}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl p-4 border border-emerald-900/10">
              <h4 className="font-bold text-sm text-emerald-950 mb-1">Did something just run out?</h4>
              <p className="text-xs text-slate-500 mb-3">One tap instantly notifies neighbors on the map.</p>
              <div className="flex flex-wrap gap-2">
                {['Produce', 'Protein', 'Dairy', 'Diapers', 'Hygiene'].map((cat) => {
                  const isOut = outAlerts.includes(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => toggleRunOut(cat)}
                      className={`text-xs px-3.5 py-2 rounded-xl font-semibold border transition ${
                        isOut
                          ? 'bg-rose-600 border-rose-700 text-white'
                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {cat} {isOut && '• Out'}
                    </button>
                  );
                })}
              </div>
            </div>

            <button className="flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-emerald-600 py-3 rounded-2xl text-sm font-semibold text-slate-700 shadow-sm transition">
              <Mic className="w-4 h-4 text-emerald-700" />
              Ask the assistant or log by voice
            </button>
          </div>
        )}

        {activeTab === 'donations' && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xl font-bold text-emerald-950">Donations in</h3>
                <span className="text-[11px] font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-emerald-600" />
                  Gemini Vision
                </span>
              </div>
              <p className="text-xs text-slate-500">Snap the pile. We sort it into your categories.</p>
            </div>

            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={fileInputRef}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleScanDonation(e.target.files[0]);
                }
              }}
            />

            {showLiveCamera ? (
              <CameraViewfinder
                onCapture={(file) => {
                  setShowLiveCamera(false);
                  handleScanDonation(file);
                }}
                onClose={() => setShowLiveCamera(false)}
              />
            ) : (
              <div className="bg-slate-900 text-white rounded-3xl p-5 flex flex-col items-center justify-center relative overflow-hidden min-h-[170px] border border-slate-700">
                {isScanning ? (
                  <div className="flex flex-col items-center gap-2 py-4">
                    <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                    <span className="text-xs text-emerald-200 font-semibold animate-pulse">
                      Gemini 3.6 Flash analyzing groceries...
                    </span>
                  </div>
                ) : (
                  <>
                    {scannedImagePreview ? (
                      <img
                        src={scannedImagePreview}
                        alt="Donation preview"
                        className="max-h-32 object-contain rounded-xl mb-2"
                      />
                    ) : (
                      <div className="flex gap-3 items-end mb-3">
                        <div className="bg-emerald-800/90 px-3 py-2 rounded-xl text-center border border-emerald-500/40">
                          <span className="text-[11px] text-emerald-200 block font-medium">Produce</span>
                          <span className="text-base font-bold">×4</span>
                        </div>
                        <div className="bg-amber-800/90 px-3 py-2.5 rounded-xl text-center border border-amber-500/40">
                          <span className="text-[11px] text-amber-200 block font-medium">Grains</span>
                          <span className="text-lg font-bold">×2</span>
                        </div>
                        <div className="bg-rose-800/90 px-3 py-2 rounded-xl text-center border border-rose-500/40">
                          <span className="text-[11px] text-rose-200 block font-medium">Protein</span>
                          <span className="text-base font-bold">×3</span>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap justify-center gap-2 mb-2">
                      <button
                        onClick={() => setShowLiveCamera(true)}
                        className="bg-[#10b981] hover:bg-[#059669] text-slate-950 text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition active:scale-95 shadow-md"
                      >
                        <Camera className="w-4 h-4 text-slate-950" />
                        Open Live Camera
                      </button>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 text-xs font-semibold px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition active:scale-95"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Upload File
                      </button>
                    </div>

                    <div className="bg-black/70 backdrop-blur-md px-3 py-1 rounded-full text-[11px] text-slate-300 flex items-center gap-1.5 mt-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      Photo is deleted immediately after sorting
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-slate-500 font-semibold">Or test with demo sample boxes:</span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleScanDonation('canned_box')}
                  className="bg-white hover:bg-emerald-50 border border-slate-200 rounded-xl p-2 text-left text-xs transition"
                >
                  🥫 <span className="font-semibold block text-slate-800">Canned Box</span>
                  <span className="text-[10px] text-slate-400">Beans &amp; Soups</span>
                </button>
                <button
                  onClick={() => handleScanDonation('produce_crate')}
                  className="bg-white hover:bg-emerald-50 border border-slate-200 rounded-xl p-2 text-left text-xs transition"
                >
                  🥕 <span className="font-semibold block text-slate-800">Produce Crate</span>
                  <span className="text-[10px] text-slate-400">Apples &amp; Carrots</span>
                </button>
                <button
                  onClick={() => handleScanDonation('baby_essentials')}
                  className="bg-white hover:bg-emerald-50 border border-slate-200 rounded-xl p-2 text-left text-xs transition"
                >
                  🍼 <span className="font-semibold block text-slate-800">Baby Box</span>
                  <span className="text-[10px] text-slate-400">Diapers &amp; Formula</span>
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-emerald-900/10 flex flex-col gap-3 shadow-xs">
              <div className="flex justify-between items-center">
                <h4 className="font-bold text-sm text-emerald-950">Check the counts</h4>
                <span className="text-xs text-slate-400">Tap to fix anything</span>
              </div>

              {Object.entries(donationCounts).map(([item, { count, category }]) => (
                <div key={item} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                  <div>
                    <span className="text-sm font-semibold text-slate-800 block">{item}</span>
                    <span className="text-xs text-emerald-800 font-medium">{category}</span>
                  </div>

                  <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-2 py-1">
                    <button
                      onClick={() =>
                        setDonationCounts({
                          ...donationCounts,
                          [item]: { count: Math.max(0, count - 1), category },
                        })
                      }
                      className="p-1 hover:bg-slate-200 rounded-lg text-slate-600 transition"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <span className="font-bold text-sm w-4 text-center">{count}</span>
                    <button
                      onClick={() =>
                        setDonationCounts({
                          ...donationCounts,
                          [item]: { count: count + 1, category },
                        })
                      }
                      className="p-1 hover:bg-slate-200 rounded-lg text-slate-600"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handleApplyDonations}
              className="bg-[#064e3b] text-white py-3.5 rounded-2xl font-bold text-sm hover:bg-[#043d2e] shadow-sm transition active:scale-[0.98] flex items-center justify-center gap-2"
            >
              {donationsAddedNotice ? '✓ Added to shelves!' : 'Add to shelves'}
            </button>

            <p className="text-xs text-center text-slate-500">
              Or just say it: <span className="italic font-medium">&quot;twelve meat soups in&quot;</span>
            </p>
          </div>
        )}

        {activeTab === 'closing' && (
          <div className="flex flex-col gap-5">
            <div>
              <h3 className="text-xl font-bold text-emerald-950">Closing check</h3>
              <p className="text-xs text-slate-500">
                Predicted from today&apos;s {familiesServed} check-ins. Confirm or override. Send update snaps
                confidence to 1.0 for the neighbor map.
              </p>
            </div>

            <div className="bg-white rounded-3xl p-4 border border-emerald-900/10 flex flex-col gap-4 shadow-xs">
              {shelf.map((item) => {
                const currentBand = closingGuesses[item.category_name] || ((item.band || 'low') as StockBand);
                return (
                  <div key={item.category_name} className="flex flex-col gap-1.5 pb-3 border-b border-slate-100 last:border-0">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-sm text-slate-900">
                        {item.category_emoji} {item.category_name}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Guess: {item.band}
                        {item.estimated_qty != null ? ` · ${item.estimated_qty} lbs` : ''}
                        {item.confidence != null ? ` · ${Math.round(Number(item.confidence) * 100)}%` : ''}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {(['plenty', 'low', 'out'] as const).map((band) => {
                        const isSelected = currentBand === band;
                        return (
                          <button
                            key={band}
                            onClick={() => {
                              setClosingGuesses({ ...closingGuesses, [item.category_name]: band });
                              if (onUpdateInventory) onUpdateInventory(item.category_name, band);
                            }}
                            className={`py-2 text-xs font-bold rounded-xl border transition ${
                              isSelected
                                ? band === 'plenty'
                                  ? 'bg-emerald-700 text-white border-emerald-800 shadow-sm'
                                  : band === 'low'
                                    ? 'bg-amber-700 text-white border-amber-800 shadow-sm'
                                    : 'bg-rose-600 text-white border-rose-700 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            {band.charAt(0).toUpperCase() + band.slice(1)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              disabled={busy}
              onClick={handleSendClosingUpdate}
              className="bg-[#064e3b] text-white py-3.5 rounded-2xl font-bold text-sm hover:bg-[#043d2e] shadow-sm transition active:scale-[0.98] disabled:opacity-50"
            >
              {closingSaved ? '✓ Ground truth published · confidence 1.0' : 'Send update'}
            </button>

            <button className="border border-rose-200 text-rose-700 hover:bg-rose-50 py-2.5 rounded-xl text-xs font-semibold transition">
              Closed next time? Let neighbors know
            </button>
          </div>
        )}

        {activeTab === 'reports' && (
          <div className="flex flex-col gap-5">
            <div>
              <h3 className="text-xl font-bold text-emerald-950">TEFAP monthly report</h3>
              <p className="text-xs text-slate-500">
                Households served, family-size breakdown, and estimated pounds from check-ins × allocation math.
              </p>
            </div>

            <div className="bg-white rounded-3xl p-4 border border-emerald-900/10 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-700">
                  Month
                  <select
                    value={reportMonth}
                    onChange={(e) => setReportMonth(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-medium"
                  >
                    {monthOptions.map((m) => (
                      <option key={m} value={m}>
                        {new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-700">
                  Year
                  <select
                    value={reportYear}
                    onChange={(e) => setReportYear(Number(e.target.value))}
                    className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-medium"
                  >
                    {[now.getFullYear(), now.getFullYear() - 1].map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-3 text-xs text-emerald-950">
                Includes {familiesServed} families already logged today at {activePantry?.name || 'this pantry'}.
              </div>

              <button
                onClick={handleExportReport}
                className="bg-[#064e3b] text-white py-3.5 rounded-2xl font-bold text-sm hover:bg-[#043d2e] flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Export Monthly Report (CSV)
              </button>
              {reportNotice && <p className="text-xs text-center text-slate-600">{reportNotice}</p>}
            </div>
          </div>
        )}
      </div>

      <div className="bg-white border-t border-emerald-900/10 px-4 py-3 flex justify-around items-center">
        <button
          onClick={() => setActiveTab('checkin')}
          className={`flex flex-col items-center gap-1 text-xs font-medium transition ${
            activeTab === 'checkin' ? 'text-emerald-800 font-bold scale-105' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <Users className="w-5 h-5" />
          <span>Check-in</span>
        </button>

        <button
          onClick={() => setActiveTab('donations')}
          className={`flex flex-col items-center gap-1 text-xs font-medium transition ${
            activeTab === 'donations' ? 'text-emerald-800 font-bold scale-105' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <Camera className="w-5 h-5" />
          <span>Donations in</span>
        </button>

        <button
          onClick={() => setActiveTab('closing')}
          className={`flex flex-col items-center gap-1 text-xs font-medium transition ${
            activeTab === 'closing' ? 'text-emerald-800 font-bold scale-105' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <CheckSquare className="w-5 h-5" />
          <span>Closing check</span>
        </button>

        <button
          onClick={() => setActiveTab('reports')}
          className={`flex flex-col items-center gap-1 text-xs font-medium transition ${
            activeTab === 'reports' ? 'text-emerald-800 font-bold scale-105' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <FileSpreadsheet className="w-5 h-5" />
          <span>Reports</span>
        </button>
      </div>
    </div>
  );
}
