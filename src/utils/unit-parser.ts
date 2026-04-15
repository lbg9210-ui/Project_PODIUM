// =============================================================
//  PODIUM — Unit Parser v2
//
//  핵심 로직: 단품 용량과 묶음 수량을 분리해 총 용량을 산출
//
//  예시:
//    "삼다수 2L 12개"       → unit=2L,   qty=12  → total=24,000ml
//    "햇반 210g x 36개"     → unit=210g, qty=36  → total=7,560g
//    "신라면 120g×5개입"    → unit=120g, qty=5   → total=600g
//    "포카리스웨트 900ml"   → unit=900ml,qty=1   → total=900ml
//    "롤화장지 30매"         → unit=30ea, qty=1   → total=30ea
//    "초코파이 12개입"       → unit=1ea,  qty=12  → total=12ea
// =============================================================

import type { ParsedUnit, UnitType } from '../types/index.js';

// -------------------------------------------------------------
//  Step 1 — 단품 용량 패턴 (부피/무게/매)
//  우선순위: ml > l > kg > g > sheet > (ea는 Step 3에서)
// -------------------------------------------------------------
const BASE_UNIT_PATTERNS: Array<{ regex: RegExp; type: UnitType }> = [
  { regex: /(\d+(?:\.\d+)?)\s*(?:ml|ML|㎖)/,                     type: 'ml'    },
  { regex: /(\d+(?:\.\d+)?)\s*(?:l|L|ℓ|리터)(?![\w가-힣])/,    type: 'l'     },
  { regex: /(\d+(?:\.\d+)?)\s*(?:kg|KG|㎏)/,                     type: 'kg'    },
  { regex: /(\d+(?:\.\d+)?)\s*(?:g|G|gr|그램)(?![\w가-힣])/,    type: 'g'     },
  { regex: /(\d+)\s*(?:매|장)/,                                   type: 'sheet' },
];

// -------------------------------------------------------------
//  Step 2 — 묶음 수량 패턴
//  단품 용량 매칭 이후 남은 문자열에서 탐색
//
//  우선순위:
//    1. 곱셈 기호 표기: ×12, x12, *12, X12
//    2. 수량 명사:      12개입, 12개, 12병, 12팩, 12캔, 12박스,
//                       12세트, 12묶음, 12입, 12봉, 12통
// -------------------------------------------------------------
const QUANTITY_PATTERNS: RegExp[] = [
  /[×xXx\*]\s*(\d+)/,                              // ×12, x12, X12, *12
  /(\d+)\s*(?:개입|개묶음|묶음|박스|세트)/,         // 12개입, 12묶음, 12박스 (긴 것 먼저)
  /(\d+)\s*(?:개|병|팩|캔|봉지|봉|통|입|구)/,       // 12개, 12병, 12팩
];

// -------------------------------------------------------------
//  Step 3 — 단위 정규화 (DB 트리거와 동일 로직 — 클라이언트 검증용)
// -------------------------------------------------------------
function normalizeUnit(
  size: number,
  type: UnitType,
): { norm_size: number; norm_type: string } {
  switch (type) {
    case 'l':     return { norm_size: size * 1000, norm_type: 'ml' };
    case 'ml':    return { norm_size: size,         norm_type: 'ml' };
    case 'kg':    return { norm_size: size * 1000, norm_type: 'g'  };
    case 'g':     return { norm_size: size,         norm_type: 'g'  };
    case 'sheet': return { norm_size: size,         norm_type: 'ea' };
    case 'piece': return { norm_size: size,         norm_type: 'ea' };
    case 'ea':    return { norm_size: size,         norm_type: 'ea' };
  }
}

// -------------------------------------------------------------
//  메인 파서
// -------------------------------------------------------------

/**
 * 상품명에서 단품 용량, 수량, 총 용량을 추출합니다.
 *
 * @param productName HTML 태그가 제거된 상품명
 * @returns ParsedUnit | null — 단위 정보를 전혀 추출할 수 없으면 null
 *
 * @example
 * parseUnit('삼다수 2L 12개')
 * // → { unit_size:2, unit_type:'l', quantity:12,
 * //     norm_unit_size:2000, norm_unit_type:'ml', total_size:24000 }
 */
export function parseUnit(productName: string): ParsedUnit | null {
  // ── 1. 단품 용량 추출
  let baseSize: number | null = null;
  let baseType: UnitType | null = null;
  let matchIndex = -1;
  let matchLength = 0;

  for (const { regex, type } of BASE_UNIT_PATTERNS) {
    const m = productName.match(regex);
    if (m?.index != null && m[1]) {
      const size = parseFloat(m[1]);
      if (size > 0) {
        baseSize  = size;
        baseType  = type;
        matchIndex  = m.index;
        matchLength = m[0].length;
        break;
      }
    }
  }

  // ── 2. 묶음 수량 추출
  //    단품 용량 매칭 위치 이후 문자열에서 탐색
  let quantity = 1;

  if (baseSize !== null) {
    // 단품 용량이 있는 경우: 그 뒤에서 수량 탐색
    const afterUnit = productName.slice(matchIndex + matchLength);
    for (const regex of QUANTITY_PATTERNS) {
      const m = afterUnit.match(regex);
      if (m?.[1]) {
        const q = parseInt(m[1], 10);
        if (q > 1) { quantity = q; break; }
      }
    }
  } else {
    // 단품 용량이 없는 경우: 개수 단위를 용량으로 처리 (ea 타입)
    for (const regex of QUANTITY_PATTERNS) {
      const m = productName.match(regex);
      const raw = m?.[1];
      if (raw) {
        const q = parseInt(raw, 10);
        if (q > 0) {
          // "초코파이 12개입" → unit_size=1ea, quantity=12
          baseSize = 1;
          baseType = 'ea';
          quantity = q;
          break;
        }
      }
    }
  }

  if (baseSize === null || baseType === null) return null;

  // ── 3. 정규화 및 총 용량 계산
  const { norm_size, norm_type } = normalizeUnit(baseSize, baseType);
  const total_size = parseFloat((norm_size * quantity).toFixed(2));

  return {
    unit_size:      baseSize,
    unit_type:      baseType,
    quantity,
    norm_unit_size: norm_size,
    norm_unit_type: norm_type,
    total_size,
  };
}

// -------------------------------------------------------------
//  총 용량 포맷터 (로그 출력용)
// -------------------------------------------------------------

/**
 * 총 용량을 사람이 읽기 좋은 문자열로 변환합니다.
 *
 * @example
 * formatTotalSize(24000, 'ml') // → "24,000ml (24L)"
 * formatTotalSize(7560,  'g')  // → "7,560g (7.56kg)"
 * formatTotalSize(12,    'ea') // → "12개"
 */
export function formatTotalSize(total: number, normType: string): string {
  if (normType === 'ml') {
    const l = total / 1000;
    return `${total.toLocaleString()}ml` + (l >= 1 ? ` (${l.toFixed(2).replace(/\.?0+$/, '')}L)` : '');
  }
  if (normType === 'g') {
    const kg = total / 1000;
    return `${total.toLocaleString()}g` + (kg >= 1 ? ` (${kg.toFixed(3).replace(/\.?0+$/, '')}kg)` : '');
  }
  return `${total.toLocaleString()}개`;
}

// -------------------------------------------------------------
//  셀프 테스트  npx ts-node --esm src/utils/unit-parser.ts
// -------------------------------------------------------------
if (process.argv[1]?.includes('unit-parser')) {
  interface TestCase {
    input: string;
    expected: { qty: number; total: number; norm_type: string } | null;
  }

  const cases: TestCase[] = [
    { input: '삼다수 2L 12개',           expected: { qty: 12, total: 24000, norm_type: 'ml' } },
    { input: '햇반 210g x 36개',          expected: { qty: 36, total:  7560, norm_type: 'g'  } },
    { input: '신라면 120g×5개입',         expected: { qty:  5, total:   600, norm_type: 'g'  } },
    { input: '포카리스웨트 900ml',        expected: { qty:  1, total:   900, norm_type: 'ml' } },
    { input: '삼다수 2L',                 expected: { qty:  1, total:  2000, norm_type: 'ml' } },
    { input: '올리브유 500ml 2병',        expected: { qty:  2, total:  1000, norm_type: 'ml' } },
    { input: '설탕 1kg',                  expected: { qty:  1, total:  1000, norm_type: 'g'  } },
    { input: '비비고 왕교자 1.05kg',      expected: { qty:  1, total:  1050, norm_type: 'g'  } },
    { input: '롤화장지 30매 6팩',         expected: { qty:  6, total:   180, norm_type: 'ea' } },
    { input: '초코파이 12개입',           expected: { qty: 12, total:    12, norm_type: 'ea' } },
    { input: '계란 30구',                 expected: { qty: 30, total:    30, norm_type: 'ea' } },
    { input: '홈런볼 (단위없음)',          expected: null },
  ];

  console.log('\n  PODIUM Unit Parser v2 — 셀프 테스트\n');
  let passed = 0;
  for (const { input, expected } of cases) {
    const result = parseUnit(input);
    const ok = expected === null
      ? result === null
      : result !== null
        && result.quantity        === expected.qty
        && result.total_size      === expected.total
        && result.norm_unit_type  === expected.norm_type;

    const detail = result
      ? `qty=${result.quantity}, total=${result.total_size}${result.norm_unit_type}`
      : 'null';

    console.log(`  ${ok ? '✅' : '❌'}  "${input.padEnd(28)}" → ${detail}`);
    if (ok) passed++;
  }
  console.log(`\n  결과: ${passed}/${cases.length} 통과\n`);
}
