export function buildMonthlyReportCsv(opts: {
  pantryName: string;
  pantryId: string;
  year: number;
  month: number;
  currentModel: string;
  checkins: Array<{
    household_size: number;
    estimated_lbs?: number | null;
    distribution_model?: string | null;
  }>;
  defaultPackLbs: number;
}): string {
  const monthLabel = `${opts.year}-${String(opts.month).padStart(2, '0')}`;
  const buckets: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8+': 0 };
  const modelCounts: Record<string, number> = {};
  let people = 0;
  let pounds = 0;

  for (const row of opts.checkins) {
    const size = Number(row.household_size) || 1;
    people += size;
    if (size >= 8) buckets['8+'] += 1;
    else if (size >= 1) buckets[String(size)] += 1;
    const model = row.distribution_model || opts.currentModel || 'client_choice';
    modelCounts[model] = (modelCounts[model] || 0) + 1;
    if (row.estimated_lbs != null) pounds += Number(row.estimated_lbs);
    else if (model === 'pre_packed') pounds += opts.defaultPackLbs;
    else pounds += size * opts.defaultPackLbs;
  }

  const lines: string[][] = [
    ['Find Food Baltimore — TEFAP / Maryland Food Bank Monthly Report'],
    ['Pantry', opts.pantryName],
    ['Pantry ID', opts.pantryId],
    ['Month', monthLabel],
    ['Generated (UTC)', new Date().toISOString()],
    ['Distribution model (current)', opts.currentModel],
    [],
    ['Metric', 'Value'],
    ['Households served', String(opts.checkins.length)],
    ['Individuals served', String(people)],
    ['Estimated / recorded pounds distributed', String(Math.round(pounds * 100) / 100)],
    [],
    ['Family size', 'Households'],
    ...['1', '2', '3', '4', '5', '6', '7', '8+'].map((key) => [key, String(buckets[key])]),
    [],
    ['Distribution model used at check-in', 'Households'],
    ...(Object.keys(modelCounts).length
      ? Object.entries(modelCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, count]) => [model, String(count)])
      : [['(none)', '0']]),
    [],
    ['Notes'],
    [
      'Pounds are estimated from check-ins × pantry allocation rates (client choice / list) or 1 fixed pack per visit (pre-packed boxes), plus any quantities logged on list-style orders.',
    ],
  ];

  return lines
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? '';
          if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
          return value;
        })
        .join(',')
    )
    .join('\n');
}
