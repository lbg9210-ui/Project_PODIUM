// ★ dotenv/config — 반드시 첫 번째 줄 (Spec)
import 'dotenv/config';

// =============================================================
//  PODIUM — Naver Scraper v4.1  (Intelligent Filter Tuning)
//
//  v4 → v4.1 변경:
//    - isNoiseProduct → checkNoise() 맥락 인지형
//    - FilterResult.whitelisted 플래그 추가
//    - 화이트리스트 통과 시 로그에 [🏷 화이트리스트 통과] 태그 표시
//    - NAVER_PLATFORM_ID optional 처리 (config crash 방지)
// =============================================================

import { searchNaverShopping }         from './scrapers/naver.js';
import { saveProduct, getPlatformId }  from './db/supabase.js';
import { resolveShippingFee }          from './utils/shipping.js';
import { formatTotalSize }             from './utils/unit-parser.js';
import {
  parseUnitWithContext,
  calculateRelevance,
  checkNoise,
} from './utils/unit-converter.js';
import type {
  NormalizedProduct,
  NaverShoppingItem,
  ScrapResult,
} from './types/index.js';

// =============================================================
//  상수
// =============================================================

const API_DELAY_MS = 1200;
const RELEVANCE_THRESHOLD = 0.4;

// =============================================================
//  Pretty Logger
// =============================================================
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  red: '\x1b[31m', gray: '\x1b[90m', blue: '\x1b[34m', magenta: '\x1b[35m',
} as const;

function pad(str: string, len: number): string {
  const w = [...str].reduce((a, c) => a + (c.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, len - w));
}

type RowStatus  = '✅' | '⏭' | '❌';
type SkipReason = 'noise' | 'unit_null' | 'unit_zero' | 'relevance' | 'price' | null;

function logProductRow(
  product:     NormalizedProduct,
  unitPrice:   number | null,
  status:      RowStatus,
  reason:      SkipReason  = null,
  relevance?:  number,
  injected?:   boolean,
  whitelisted?: boolean,
): void {
  const p = product.parsedUnit;

  const totalStr = p ? formatTotalSize(p.total_size, p.norm_unit_type) : '─';
  const shipStr  = product.shipping.is_estimated
    ? `${C.yellow}~${product.shipping.fee_won.toLocaleString()}원${C.reset}${C.gray}(추정)${C.reset}`
    : product.shipping.is_free ? `${C.green}무료${C.reset}`
                                : `${product.shipping.fee_won.toLocaleString()}원`;

  // 단위당 가격 + 부가 태그
  let unitStr = unitPrice != null
    ? `${C.bold}${C.cyan}${unitPrice.toFixed(2)}원/${p?.norm_unit_type ?? '?'}${C.reset}`
    : `${C.gray}─${C.reset}`;
  if (injected)    unitStr += ` ${C.yellow}[⚡키워드 주입]${C.reset}`;
  if (whitelisted) unitStr += ` ${C.green}[🏷 화이트리스트 통과]${C.reset}`;

  // 스킵 사유
  const reasonMap: Record<NonNullable<SkipReason>, string> = {
    noise:     `${C.red}노이즈${C.reset}`,
    unit_null: `${C.gray}단위 파싱 실패${C.reset}`,
    unit_zero: `${C.gray}unit_size=0${C.reset}`,
    relevance: `${C.yellow}관련성 낮음 (${relevance?.toFixed(2)} < ${RELEVANCE_THRESHOLD})${C.reset}`,
    price:     `${C.gray}가격 없음${C.reset}`,
  };

  console.log(
    `  ${status} ${C.bold}${pad(product.name, 26)}${C.reset}` +
    ` ${C.gray}│${C.reset} ${C.magenta}${pad(totalStr, 16)}${C.reset}` +
    ` ${C.gray}│${C.reset} ${pad(product.priceWon.toLocaleString() + '원', 10)}` +
    ` + ${pad(shipStr, 14)} = ${pad(product.totalPrice.toLocaleString() + '원', 10)}` +
    ` ${C.gray}│${C.reset} ${unitStr}` +
    (reason ? `  ${reasonMap[reason]}` : ''),
  );
}

function logKeywordHeader(keyword: string, count: number): void {
  const line = '─'.repeat(110);
  console.log(`\n${C.bold}${C.blue}  키워드: "${keyword}"  (${count}건 수신)${C.reset}`);
  console.log(`${C.gray}  ${line}`);
  console.log(
    `  ${pad('상품명', 26)} │ ${pad('총 용량', 14)} │ ${'판매가'.padEnd(10)}   ` +
    `${'배송비'.padEnd(12)}   ${'최종가'.padEnd(10)} │ 단위당 가격${C.reset}`,
  );
  console.log(`${C.gray}  ${line}${C.reset}`);
}

function logSummaryTable(results: ScrapResult[]): void {
  const div = (l: string, m: string, r: string) =>
    `  ${l}${'─'.repeat(30)}${m}${'─'.repeat(9)}${m}${'─'.repeat(9)}${m}${'─'.repeat(11)}${r}`;

  console.log(`\n${C.bold}${div('┌', '┬', '┐')}${C.reset}`);
  console.log(`${C.bold}  │${'  실행 결과 요약'.padEnd(62)}│${C.reset}`);
  console.log(`${C.bold}${div('├', '┼', '┤')}${C.reset}`);
  console.log(`  │ ${'키워드'.padEnd(28)} │${'수신'.padStart(7)}  │${'저장'.padStart(7)}  │${'스킵/오류'.padStart(9)}  │`);
  console.log(div('├', '┼', '┤'));

  let tF = 0, tI = 0, tS = 0;
  for (const r of results) {
    const errTag = r.errors.length ? ` ${C.red}(오류${r.errors.length})${C.reset}` : '';
    console.log(
      `  │ ${pad(r.keyword, 28)} │${String(r.fetched).padStart(7)}  │` +
      `${C.green}${String(r.inserted).padStart(7)}${C.reset}  │${String(r.skipped).padStart(9)}${errTag}  │`,
    );
    tF += r.fetched; tI += r.inserted; tS += r.skipped;
  }
  console.log(div('├', '┼', '┤'));
  console.log(
    `  │ ${C.bold}합계${C.reset}${' '.repeat(26)} │` +
    `${C.bold}${String(tF).padStart(7)}${C.reset}  │` +
    `${C.green}${C.bold}${String(tI).padStart(7)}${C.reset}  │${String(tS).padStart(9)}  │`,
  );
  console.log(div('└', '┴', '┘'));
  console.log();
}

// =============================================================
//  NormalizedProduct 빌더
// =============================================================
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .trim();
}

function buildNormalizedProduct(
  item:    NaverShoppingItem,
  keyword: string,
): NormalizedProduct {
  const name       = stripHtml(item.title);
  const priceWon   = parseInt(item.lprice, 10) || 0;
  const shipping   = resolveShippingFee(item);
  const totalPrice = priceWon + shipping.fee_won;
  const parsedUnit = parseUnitWithContext(name, keyword);

  const unitPrice =
    parsedUnit && parsedUnit.total_size > 0 && totalPrice > 0
      ? parseFloat((totalPrice / parsedUnit.total_size).toFixed(2))
      : null;

  return {
    rawTitle: item.title, name,
    brand:    item.brand     || null,
    category: item.category1 || null,
    imageUrl: item.image, sourceUrl: item.link, mallName: item.mallName,
    priceWon, shipping, totalPrice, parsedUnit, unitPrice,
  };
}

// =============================================================
//  필터 파이프라인
// =============================================================
interface FilterResult {
  pass:         boolean;
  reason:       SkipReason;
  relevance?:   number;
  injected?:    boolean;
  /** 화이트리스트 덕분에 노이즈 필터를 통과한 경우 */
  whitelisted?: boolean;
}

function applyFilters(product: NormalizedProduct, keyword: string): FilterResult {
  const p = product.parsedUnit;

  // ── 0. 맥락 인지형 노이즈 검사 (v4.1)
  const noise = checkNoise(product.name);
  if (noise.isNoise) {
    return { pass: false, reason: 'noise' };
  }
  // 화이트리스트 통과 여부는 저장 이후 로그에 표시
  const whitelisted = noise.whitelisted;

  // ── 1. unit_size null
  if (!p || p.unit_size == null) {
    return { pass: false, reason: 'unit_null' };
  }

  // ── 2. unit_size = 0
  if (p.unit_size === 0 || p.total_size === 0) {
    return { pass: false, reason: 'unit_zero' };
  }

  // ── 3. 관련성 점수 미달
  const relevance = calculateRelevance(product.name, keyword);
  if (relevance < RELEVANCE_THRESHOLD) {
    return { pass: false, reason: 'relevance', relevance };
  }

  // ── 4. 가격 없음
  if (product.priceWon <= 0) {
    return { pass: false, reason: 'price' };
  }

  // Reference Injection 여부
  const nameHasWeightVol = /\d+\s*(ml|ML|g|G|l|L|kg|KG)/.test(product.name);
  const injected = p.norm_unit_type !== 'ea' && !nameHasWeightVol;

  return { pass: true, reason: null, relevance, injected, whitelisted };
}

// =============================================================
//  키워드 목록
// =============================================================
const DEFAULT_KEYWORDS: string[] = [
  '삼다수 2L 12개',
  '햇반 210g 36개',
  '신라면 120g 5개입',
  '포카리스웨트 900ml',
  '비비고 왕교자 1.05kg',
  '오뚜기 진라면 110g',
  '롯데 칠성사이다 1.5L',
  '코카콜라 250ml 30캔',
];

function parseCliKeywords(): string[] | null {
  const idx = process.argv.indexOf('--keywords');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1].split(',').map((k) => k.trim()).filter(Boolean);
  }
  return null;
}

// =============================================================
//  메인
// =============================================================
async function main(): Promise<void> {
  const keywords = parseCliKeywords() ?? DEFAULT_KEYWORDS;

  console.log('\n' + '═'.repeat(110));
  console.log(`${C.bold}  PODIUM — Naver Scraper v4.1  (Intelligent Filter Tuning)${C.reset}`);
  console.log(
    `  ${C.gray}맥락 인지 노이즈 필터 | 화이트리스트 구제 | Keyword Reference Injection${C.reset}`,
  );
  console.log(`  키워드: ${keywords.length}개  |  딜레이: ${API_DELAY_MS}ms  |  관련성 임계: ${RELEVANCE_THRESHOLD}`);
  console.log('═'.repeat(110));

  // ── Step 0: platformId 확보 (DB에서 직접 조회 — env 의존 없음)
  console.log(`\n${C.bold}🔌  Step 0. 플랫폼 ID 확보${C.reset}`);
  let platformId: string;
  try {
    platformId = await getPlatformId('naver_store');
    console.log(`  ✅ naver_store → ${C.cyan}${platformId}${C.reset}`);
  } catch (err) {
    console.error(`  ${C.red}❌ 플랫폼 ID 조회 실패: ${(err as Error).message}${C.reset}`);
    process.exit(1);
  }

  // ── Step 1: 네이버 API 검색
  console.log(`\n${C.bold}📡  Step 1. 네이버 쇼핑 API 검색 (딜레이 ${API_DELAY_MS}ms)${C.reset}\n`);

  const rawMap = new Map<string, NaverShoppingItem[]>();
  for (const [i, keyword] of keywords.entries()) {
    console.log(`  [${i + 1}/${keywords.length}] "${keyword}" 검색 중...`);
    try {
      const items = await searchNaverShopping(keyword);
      rawMap.set(keyword, items);
      console.log(`    → ${items.length}건 수신`);
    } catch (err) {
      console.error(`    → ${C.red}실패: ${(err as Error).message}${C.reset}`);
      rawMap.set(keyword, []);
    }
    if (i < keywords.length - 1) {
      await new Promise((r) => setTimeout(r, API_DELAY_MS));
    }
  }

  // ── Step 2: 필터링 + 정규화 + DB 저장
  console.log(`\n${C.bold}💾  Step 2. 필터링 & Supabase 저장${C.reset}`);

  const summary: ScrapResult[] = [];

  for (const [keyword, rawItems] of rawMap.entries()) {
    logKeywordHeader(keyword, rawItems.length);

    const result: ScrapResult = {
      keyword, fetched: rawItems.length, inserted: 0, skipped: 0, errors: [],
    };

    for (const item of rawItems) {
      const product = buildNormalizedProduct(item, keyword);
      const { pass, reason, relevance, injected, whitelisted } =
        applyFilters(product, keyword);

      if (!pass) {
        logProductRow(product, null, '⏭', reason, relevance);
        result.skipped++;
        continue;
      }

      // saveProduct에 DB 조회로 확보한 실제 platformId 전달
      const saveResult = await saveProduct(product, platformId);

      if (saveResult.success) {
        const dbUnitPrice = saveResult.dbRow?.unit_price ?? null;

        // DB 트리거 교차 검증
        if (dbUnitPrice !== null && product.unitPrice !== null) {
          if (Math.abs(dbUnitPrice - product.unitPrice) > 0.01) {
            console.warn(
              `  ${C.yellow}⚠ unit_price 불일치 — client:${product.unitPrice} / DB:${dbUnitPrice}${C.reset}`,
            );
          }
        }

        // whitelisted=true면 [🏷 화이트리스트 통과] 태그 로그 출력
        logProductRow(product, dbUnitPrice, '✅', null, relevance, injected, whitelisted);
        result.inserted++;
      } else {
        logProductRow(product, null, '❌', null);
        result.errors.push(`"${product.name}": ${saveResult.error}`);
      }
    }

    summary.push(result);
    console.log(`${C.gray}${'─'.repeat(110)}${C.reset}`);
  }

  // ── Step 3: 요약
  logSummaryTable(summary);

  const allErrors = summary.flatMap((r) => r.errors);
  if (allErrors.length > 0) {
    console.log(`${C.red}  ⚠ 오류 목록 (${allErrors.length}건):${C.reset}`);
    allErrors.forEach((e) => console.log(`  ${C.red}•${C.reset} ${e}`));
    console.log();
  }

  console.log(`  ${C.green}${C.bold}✅ 스크래핑 완료${C.reset}\n`);
}

main().catch((err) => {
  console.error(`\n${C.red}❌ 치명적 오류:${C.reset}`, err);
  process.exit(1);
});
