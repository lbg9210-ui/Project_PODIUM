// =============================================================
//  PODIUM — Shipping Fee Resolver
//
//  네이버 쇼핑 검색 API는 배송비를 직접 제공하지 않음.
//  아래 3단계 우선순위로 배송비를 결정합니다:
//    1. 상품명/mallName에 "무료배송" 포함 → 0원
//    2. mallName별 알려진 정책 적용
//    3. 그 외 → 기본 추정값 사용 (is_estimated=true 표시)
// =============================================================

import type { NaverShoppingItem, ShippingInfo } from '../types/index.js';

/** 무료배송 키워드 */
const FREE_SHIPPING_KEYWORDS = ['무료배송', '무료 배송', '로켓배송', '로켓프레시', '새벽배송'];

/** mallName별 배송비 정책 (원) */
const MALL_SHIPPING_POLICY: Record<string, number> = {
  '쿠팡':          0,    // 로켓배송 기본 무료
  '마켓컬리':      0,    // 새벽배송 기본 무료 (3만원 이상)
  '오아시스마켓':  0,
  'SSG닷컴':    3000,
  'GS샵':       3000,
  'CJ온마트':   3000,
};

/** 기본 추정 배송비 (정책 불명 쇼핑몰) */
const DEFAULT_SHIPPING_FEE = 3000;

/**
 * 네이버 API 아이템에서 배송비를 결정합니다.
 */
export function resolveShippingFee(item: NaverShoppingItem): ShippingInfo {
  const titleAndMall = `${item.title} ${item.mallName}`;

  // 1순위: 무료배송 키워드
  if (FREE_SHIPPING_KEYWORDS.some((kw) => titleAndMall.includes(kw))) {
    return { fee_won: 0, is_free: true, is_estimated: false };
  }

  // 2순위: mallName 정책
  for (const [mall, fee] of Object.entries(MALL_SHIPPING_POLICY)) {
    if (item.mallName.includes(mall)) {
      return { fee_won: fee, is_free: fee === 0, is_estimated: false };
    }
  }

  // 3순위: 기본 추정값
  return {
    fee_won:      DEFAULT_SHIPPING_FEE,
    is_free:      false,
    is_estimated: true,
  };
}
