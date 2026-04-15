// =============================================================
//  PODIUM — Naver Shopping API Client
//  raw NaverShoppingItem만 반환. 정규화는 index.ts에서 수행.
// =============================================================

import { config } from '../config/index.js';
import type { NaverShoppingItem, NaverSearchResponse } from '../types/index.js';

const NAVER_API_URL = 'https://openapi.naver.com/v1/search/shop.json';

/**
 * 네이버 쇼핑 API 단일 키워드 검색
 */
export async function searchNaverShopping(
  keyword: string,
  // config에서 값이 안 넘어올 경우를 대비해 기본값 10을 강제합니다.
  display: number = Number(config.naver.display) || 10,
): Promise<NaverShoppingItem[]> {
  
  // display 값은 반드시 1~100 사이여야 합니다.
  const safeDisplay = Math.min(Math.max(display, 1), 100);

  const params = new URLSearchParams({
    query:   keyword,
    display: String(safeDisplay),
    sort:    'sim',   // 최저가순 보다는 유사도순으로 가져와서 2L/500ml 섞인걸 필터링하는게 유리합니다.
  });

  const response = await fetch(`${NAVER_API_URL}?${params}`, {
    headers: {
      'X-Naver-Client-Id':     config.naver.clientId,
      'X-Naver-Client-Secret': config.naver.clientSecret,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    // 여기서 에러를 던지면 fetchAll의 catch에서 잡힙니다.
    throw new Error(`API 오류 [${response.status}] : ${body}`);
  }

  const data = (await response.json()) as NaverSearchResponse;
  return data.items || [];
}

/**
 * 키워드 리스트 전체 순차 검색
 * 쿼터 보호용 딜레이 포함
 */
export async function fetchAll(
  keywords: string[],
): Promise<Map<string, NaverShoppingItem[]>> {
  const results = new Map<string, NaverShoppingItem[]>();

  // config에 delayMs가 없으면 최소 1200ms(1.2초)를 대기합니다.
  const delayTime = Number(config.naver.delayMs) || 1200;

  for (const [i, keyword] of keywords.entries()) {
    console.log(`  [${i + 1}/${keywords.length}] 검색 중: "${keyword}"`);
    try {
      const items = await searchNaverShopping(keyword);
      results.set(keyword, items);
      console.log(`    → ${items.length}건 수신 완료`);
    } catch (err) {
      // 400, 429 등의 상세 에러가 여기서 찍힙니다.
      console.error(`    → 실패: ${(err as Error).message}`);
      results.set(keyword, []);
    }

    // 마지막 키워드가 아닐 때만 대기 (Throttle)
    if (i < keywords.length - 1) {
      await new Promise((r) => setTimeout(r, delayTime));
    }
  }

  return results;
}
