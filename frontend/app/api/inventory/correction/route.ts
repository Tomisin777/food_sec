import { NextRequest, NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { recordCorrection } from '@/lib/operatorStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const pantryId = body.pantry_id as string;
  const corrections = body.corrections as Array<{
    category_id?: number;
    category_name?: string;
    band: string;
    estimated_qty?: number | null;
  }>;

  if (!pantryId || !Array.isArray(corrections) || corrections.length === 0) {
    return NextResponse.json({ detail: 'pantry_id and corrections are required' }, { status: 400 });
  }

  const backend = await tryBackend('/api/inventory/correction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (backend) {
    return new NextResponse(await backend.text(), {
      status: backend.status,
      headers: { 'Content-Type': backend.headers.get('Content-Type') || 'application/json' },
    });
  }

  const pantry = recordCorrection(pantryId, corrections);
  return NextResponse.json({
    status: 'success',
    source: 'volunteer_correction',
    confidence: 1.0,
    updated: pantry.shelf.map((item) => ({
      category_id: item.category_id,
      category_name: item.category_name,
      band: item.band,
      estimated_qty: item.estimated_qty,
      source: item.source,
      confidence: item.confidence,
    })),
  });
}
