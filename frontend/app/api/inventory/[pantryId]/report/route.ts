import { NextRequest, NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { defaultPackLbs } from '@/lib/estimator';
import { getPantryState, monthCheckIns } from '@/lib/operatorStore';
import { buildMonthlyReportCsv } from '@/lib/reportCsv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ pantryId: string }> }) {
  const { pantryId } = await context.params;
  const url = new URL(req.url);
  const now = new Date();
  const year = Number(url.searchParams.get('year') || now.getFullYear());
  const month = Number(url.searchParams.get('month') || now.getMonth() + 1);

  const backend = await tryBackend(`/api/inventory/${pantryId}/report?year=${year}&month=${month}`);
  if (backend) {
    return new NextResponse(await backend.arrayBuffer(), {
      status: backend.status,
      headers: {
        'Content-Type': backend.headers.get('Content-Type') || 'text/csv',
        'Content-Disposition':
          backend.headers.get('Content-Disposition') ||
          `attachment; filename="tefap-report-${year}-${String(month).padStart(2, '0')}-${pantryId}.csv"`,
      },
    });
  }

  const pantry = getPantryState(pantryId);
  const checkins = monthCheckIns(pantryId, year, month);
  const csv = buildMonthlyReportCsv({
    pantryName: pantry.name,
    pantryId,
    year,
    month,
    currentModel: pantry.distribution_model,
    checkins,
    defaultPackLbs: defaultPackLbs(pantry.shelf),
  });
  const filename = `tefap-report-${year}-${String(month).padStart(2, '0')}-${pantryId}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
