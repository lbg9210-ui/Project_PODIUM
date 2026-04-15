// =============================================================
//  PODIUM — Unit Converter v4.1
//  표준 단위 변환 + 맥락 인지형 노이즈 필터 + Keyword Reference Injection
//
//  v4 → v4.1 변경:
//    - isNoiseProduct: 단순 키워드 매칭 → 2단계 맥락 인지형
//      · 1단계 블랙리스트: 단가 비교 불가 패턴 차단
//      · 2단계 화이트리스트: '랜덤' 앞뒤에 포장 관련 단어 있으면 통과
//    - checkNoise(): 판정 근거를 반환하는 상세 버전 (index.ts 로그용)
// =============================================================

import { parseUnit } from './unit-parser.js';
import type { ParsedUnit, UnitType } from '../types/index.js';

// =============================================================
//  standardizeUnit  (유지)
// =============================================================

export interface StandardizedUnit {
  value: number;
  unit:  'ml' | 'g' | 'ea';
}

export function standardizeUnit(value: number, unit: string): StandardizedUnit {
  const u = unit.toLowerCase().trim();
  switch (u) {
    case 'l': case 'ℓ': case '리터':
      return { value: value * 1000, unit: 'ml' };
    case 'ml': case '㎖':
      return { value, unit: 'ml' };
    case 'kg': case '㎏':
      return { value: value * 1000, unit: 'g' };
    case 'g': case 'gr': case '그램':
      return { value, unit: 'g' };
    case 'ea': case '개': case '개입': case '입': case '구':
    case '병': case '팩': case '캔': case '통': case '봉':
    case '봉지': case 'sheet': case '매': case '장':
    case 'piece': case '조각':
      return { value, unit: 'ea' };
    default:
      return { value, unit: 'ea' };
  }
}

// =============================================================
//  맥락 인지형 노이즈 필터  (v4.1 핵심 변경)
//
//  구조:
//    블랙리스트 — 단가 비교가 원천적으로 불가한 복합 패턴
//    화이트리스트 — '랜덤' 이 포장/디자인 맥락에서 쓰인 경우 구제
//
//  판단 흐름:
//    1. 블랙리스트 패턴 매칭 → 즉시 noise
//    2. '랜덤' 포함 여부 확인
//       2a. 화이트리스트 단어가 랜덤 앞뒤 ±5자 이내 → NOT noise (구제)
//       2b. 화이트리스트 미해당 → noise
//    3. 기타 단독 노이즈 단어 확인
//    4. 위 모두 미해당 → not noise
// =============================================================

/**
 * 블랙리스트 1 — 단독으로 쓰여도 반드시 차단되는 단어/구문
 * ("랜덤"은 별도 2단계에서 화이트리스트와 함께 판단)
 */
const BLACKLIST_STANDALONE: readonly string[] = [
  '각 1개씩', '각1개씩',
  '혼합구성', '혼합 구성',
  '어시', '모듬',
  '기획팩', '증정품', '사은품',
];

/**
 * 블랙리스트 2 — '랜덤'과 결합된 형태여야 차단되는 접두/접미어
 * 이 단어들이 '랜덤' 앞뒤 5자 이내에 있으면 차단
 */
const BLACKLIST_RANDOM_PREFIXES: readonly string[] = [
  '색상', '컬러', '맛', '향', '종류', '스타일',
];

/**
 * 화이트리스트 — '랜덤'과 결합돼도 내용물은 동일한 포장/디자인 맥락
 * 이 단어들이 '랜덤' 앞뒤 5자 이내에 있으면 차단하지 않고 통과
 */
const WHITELIST_RANDOM_ADJACENTS: readonly string[] = [
  '라벨', '무라벨', '디자인', '포장', '패키지', '겉면', '외관',
];

/** 인접 여부 판단 윈도우 (글자 수) */
const ADJACENT_WINDOW = 5;

/** '랜덤' 전후 ADJACENT_WINDOW자 이내에 특정 단어가 있는지 확인 */
function isAdjacentToRandom(title: string, words: readonly string[]): boolean {
  const idx = title.indexOf('랜덤');
  if (idx === -1) return false;

  // 랜덤 주변 슬라이딩 윈도우 추출
  const windowStart = Math.max(0, idx - ADJACENT_WINDOW);
  const windowEnd   = Math.min(title.length, idx + '랜덤'.length + ADJACENT_WINDOW);
  const window      = title.slice(windowStart, windowEnd);

  return words.some((w) => window.includes(w));
}

// -------------------------------------------------------------
//  checkNoise — 판정 근거까지 반환하는 상세 버전
// -------------------------------------------------------------

export interface NoiseCheckResult {
  /** 최종 노이즈 판정 */
  isNoise:      boolean;
  /** 차단 사유 (노이즈일 때만 설정) */
  blockedBy?:   string;
  /**
   * 화이트리스트 덕분에 통과된 경우 true.
   * "랜덤"이 있었지만 포장 맥락이어서 구제됨.
   */
  whitelisted:  boolean;
}

/**
 * 상품명을 맥락 인지 방식으로 노이즈 검사합니다.
 *
 * @example
 * checkNoise('삼다수 2L 무라벨 랜덤발송')
 * // → { isNoise:false, whitelisted:true }
 *
 * checkNoise('향 랜덤 발송 음료수 세트')
 * // → { isNoise:true, blockedBy:'향+랜덤', whitelisted:false }
 *
 * checkNoise('신라면 120g 5개입')
 * // → { isNoise:false, whitelisted:false }
 */
export function checkNoise(title: string): NoiseCheckResult {
  // ── 1단계: 블랙리스트(단독 패턴) 검사
  for (const kw of BLACKLIST_STANDALONE) {
    if (title.includes(kw)) {
      return { isNoise: true, blockedBy: `'${kw}'`, whitelisted: false };
    }
  }

  // ── 2단계: '랜덤' 포함 여부
  if (title.includes('랜덤')) {
    // 2a. 화이트리스트 단어가 랜덤 주변에 있으면 → 구제 (통과)
    if (isAdjacentToRandom(title, WHITELIST_RANDOM_ADJACENTS)) {
      return { isNoise: false, whitelisted: true };
    }

    // 2b. 블랙리스트 접두/접미어가 랜덤 주변에 있으면 → 차단
    const blockedPrefix = BLACKLIST_RANDOM_PREFIXES.find(
      (p) => isAdjacentToRandom(title.replace('랜덤', p + '랜덤'), [p + '랜덤']) ||
             isAdjacentToRandom(title, [p]),
    );
    if (blockedPrefix) {
      return { isNoise: true, blockedBy: `'${blockedPrefix}+랜덤'`, whitelisted: false };
    }

    // 2c. 화이트리스트도 블랙리스트도 아닌 '랜덤' → 차단 (불명확한 랜덤은 보수적 처리)
    return { isNoise: true, blockedBy: "'랜덤'(미분류)", whitelisted: false };
  }

  // ── 3단계: 이상 없음
  return { isNoise: false, whitelisted: false };
}

/**
 * 하위 호환성을 위한 래퍼.
 * checkNoise()의 isNoise 값만 반환합니다.
 */
export function isNoiseProduct(title: string): boolean {
  return checkNoise(title).isNoise;
}

// =============================================================
//  parseUnitWithContext  (v4에서 유지)
// =============================================================

interface ReferenceUnit {
  rawValue: number;
  rawUnit:  string;
  std:      StandardizedUnit;
}

const QTY_ONLY_PATTERNS: RegExp[] = [
  /[×xXx\*]\s*(\d+)/,
  /(\d+)\s*(?:개입|개묶음|묶음|박스|세트)/,
  /(\d+)\s*(?:개|병|팩|캔|봉지|봉|통|입|구)/,
];

function extractReferenceUnit(keyword: string): ReferenceUnit | null {
  const m = keyword.match(
    /(\d+(?:\.\d+)?)\s*(ml|ML|㎖|l|L|ℓ|리터|kg|KG|㎏|g|G|그램|gr)(?![\w가-힣])/,
  );
  if (!m) return null;
  const rawValue = parseFloat(m[1]);
  const rawUnit  = m[2];
  const std      = standardizeUnit(rawValue, rawUnit);
  if (std.unit === 'ea') return null;
  return { rawValue, rawUnit, std };
}

function extractQuantityFromTitle(title: string): number | null {
  for (const regex of QTY_ONLY_PATTERNS) {
    const m = title.match(regex);
    if (m?.[1]) {
      const q = parseInt(m[1], 10);
      if (q > 1) return q;
    }
  }
  return null;
}

/**
 * 상품명 + 검색 키워드를 함께 사용해 단위를 파싱합니다.
 * 상품명에 ml/g이 없고 키워드에 있으면 Keyword Reference Injection을 적용합니다.
 *
 * @example
 * parseUnitWithContext('신라면 5개입', '신라면 120g')
 * // → { unit_size:120, unit_type:'g', quantity:5, total_size:600 }
 */
export function parseUnitWithContext(
  title: string,
  keyword: string,
): ParsedUnit | null {
  const normal = parseUnit(title);

  if (normal !== null && normal.norm_unit_type !== 'ea') {
    return normal; // 상품명에 이미 무게/부피 있음
  }

  const ref = extractReferenceUnit(keyword);
  if (ref === null) return normal; // 키워드에도 기준 단위 없음

  const qty       = extractQuantityFromTitle(title);
  const totalSize = parseFloat((ref.std.value * (qty ?? 1)).toFixed(2));

  return {
    unit_size:      ref.std.value,
    unit_type:      ref.std.unit as UnitType,
    quantity:       qty ?? 1,
    norm_unit_size: ref.std.value,
    norm_unit_type: ref.std.unit,
    total_size:     totalSize,
  };
}

// =============================================================
//  calculateRelevance  (v4에서 유지 + 노이즈 패널티 연동)
// =============================================================

interface ParsedKeyword {
  tokens:    string[];
  sizeValue: number | null;
  sizeUnit:  string | null;
}

function parseKeyword(keyword: string): ParsedKeyword {
  const sizeMatch = keyword.match(
    /(\d+(?:\.\d+)?)\s*(ml|ML|l|L|ℓ|kg|KG|g|G|매|장|개입|개|구|ea)/,
  );
  let sizeValue: number | null = null;
  let sizeUnit:  string | null = null;
  let remaining = keyword;
  if (sizeMatch) {
    sizeValue = parseFloat(sizeMatch[1]);
    sizeUnit  = sizeMatch[2];
    remaining = keyword.replace(sizeMatch[0], '');
  }
  const tokens = remaining
    .split(/[\s×x\*,/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return { tokens, sizeValue, sizeUnit };
}

export function calculateRelevance(title: string, keyword: string): number {
  if (isNoiseProduct(title)) return 0.0;

  const parsed   = parseKeyword(keyword);
  const titleLow = title.toLowerCase();

  let tokenScore = 0;
  if (parsed.tokens.length > 0) {
    const matched = parsed.tokens.filter((t) => titleLow.includes(t.toLowerCase())).length;
    tokenScore = matched / parsed.tokens.length;
  } else {
    tokenScore = 0.5;
  }

  let sizeScore = 0;
  if (parsed.sizeValue !== null && parsed.sizeUnit !== null) {
    const keyStd     = standardizeUnit(parsed.sizeValue, parsed.sizeUnit);
    const titleSizes = [...title.matchAll(/(\d+(?:\.\d+)?)\s*(ml|ML|l|L|ℓ|kg|KG|g|G)/g)];
    if (titleSizes.length === 0) {
      sizeScore = 0.3;
    } else {
      let bestRatio = 0;
      for (const m of titleSizes) {
        const titleStd = standardizeUnit(parseFloat(m[1]), m[2]);
        if (titleStd.unit !== keyStd.unit) continue;
        const ratio = Math.min(titleStd.value, keyStd.value) /
                      Math.max(titleStd.value, keyStd.value);
        if (ratio > bestRatio) bestRatio = ratio;
      }
      sizeScore = bestRatio >= 0.8 ? 1.0 : bestRatio >= 0.5 ? 0.5 : bestRatio > 0 ? 0.2 : 0;
    }
  } else {
    sizeScore = 0.5;
  }

  return parseFloat((tokenScore * 0.6 + sizeScore * 0.4).toFixed(2));
}

// =============================================================
//  Self-test   npx ts-node --esm src/utils/unit-converter.ts
// =============================================================
if (process.argv[1]?.includes('unit-converter')) {
  const SEP = '  ' + '─'.repeat(72);

  console.log('\n  [1] standardizeUnit');
  console.log(SEP);
  (
    [[2,'L',2000,'ml'],[1.5,'kg',1500,'g'],[900,'ml',900,'ml'],[12,'개입',12,'ea']] as
    Array<[number,string,number,string]>
  ).forEach(([v,u,ev,eu]) => {
    const r = standardizeUnit(v, u);
    console.log(`  ${r.value===ev&&r.unit===eu?'✅':'❌'}  ${v}${u.padEnd(5)} → ${r.value}${r.unit}`);
  });

  console.log('\n  [2] checkNoise — 맥락 인지형 (v4.1 핵심)');
  console.log(SEP);
  const noiseCases: Array<[string, boolean, boolean]> = [
    // [title, expectedIsNoise, expectedWhitelisted]
    ['삼다수 2L 무라벨 랜덤발송',              false, true  ],  // 무라벨+랜덤 → 화이트리스트
    ['삼다수 2L 라벨 랜덤 발송',               false, true  ],  // 라벨+랜덤 → 화이트리스트
    ['포카리스웨트 디자인랜덤 발송',            false, true  ],  // 디자인+랜덤 → 화이트리스트
    ['음료수 향 랜덤 발송',                    true,  false ],  // 향+랜덤 → 블랙리스트
    ['스낵 색상랜덤 세트',                     true,  false ],  // 색상+랜덤 → 블랙리스트
    ['과자 혼합구성 12개입',                   true,  false ],  // 혼합구성 → 블랙리스트
    ['신라면 120g 5개입',                      false, false ],  // 정상 상품
    ['비타민 기획팩 30정',                     true,  false ],  // 기획팩 → 블랙리스트
    ['생수 패키지 랜덤',                       false, true  ],  // 패키지+랜덤 → 화이트리스트
  ];
  noiseCases.forEach(([title, expNoise, expWhite]) => {
    const r  = checkNoise(title);
    const ok = r.isNoise === expNoise && r.whitelisted === expWhite;
    const tag = r.whitelisted ? ' 🏷화이트리스트' : r.isNoise ? ` 🚫${r.blockedBy}` : '';
    console.log(`  ${ok?'✅':'❌'}  isNoise=${String(r.isNoise).padEnd(5)} white=${String(r.whitelisted).padEnd(5)} "${title.substring(0,30)}"${tag}`);
  });

  console.log('\n  [3] parseUnitWithContext');
  console.log(SEP);
  (
    [
      ['신라면 5개입',        '신라면 120g',    600,  'g' ],
      ['코카콜라 6캔',        '코카콜라 250ml', 1500, 'ml'],
      ['삼다수 2L 12개입',    '삼다수 2L',      24000,'ml'],
      ['햇반 36개',           '햇반 210g',      7560, 'g' ],
    ] as Array<[string,string,number,string]>
  ).forEach(([title,kw,expTotal,expType]) => {
    const r = parseUnitWithContext(title, kw);
    const ok = r !== null && r.total_size === expTotal && r.norm_unit_type === expType;
    console.log(`  ${ok?'✅':'❌'}  "${title.padEnd(20)}" + kw="${kw}" → ${r?.total_size}${r?.norm_unit_type} qty=${r?.quantity}`);
  });
  console.log();
}
