/** Temporary probe: descriptions through the production pipeline. */
import 'dotenv/config';
import { processArticle } from '../services/dashboardPipeline.service.js';
import type { ShopArticle } from '../ingest/eposListing.js';

const DESCRIPTIONS = [
  'WRIGLEYS EXTRA SPEARMINT',
  'AIRWAVES BLACKMINT',
];

for (const [index, description] of DESCRIPTIONS.entries()) {
  const article: ShopArticle = {
    articleCode: `P${index}`,
    sourceRow: index + 1,
    descriptionRaw: description,
    description,
    packRaw: '',
    cases: 1,
  };

  const result = await processArticle(article);
  console.log(`'${description}'`);
  console.log(`  identity: '${result.diagnostics.canonicalIdentity}'`);
  for (const level of result.diagnostics.retrieval) {
    console.log(`    L${level.level} ${String(level.candidates).padStart(3)}  "${level.query}"`);
  }
  console.log(`  candidates: ${result.diagnostics.candidateCount}`);
  for (const judgement of result.judgements.slice(0, 3)) {
    console.log(`    [${judgement.candidateIndex}] ${judgement.candidate} → ${judgement.decision}`);
    for (const rule of judgement.rules) {
      if (rule.status === 'fail') console.log(`          FAIL ${rule.label}: ${rule.detail}`);
    }
  }
  console.log(
    `  ROW: ${result.row.kind === 'ready' ? `READY → ${result.row.detail.selected?.product}` : `${result.row.status} — ${result.row.reason}`}`,
  );
  console.log('');
}
