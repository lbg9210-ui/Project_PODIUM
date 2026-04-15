// =============================================================
//  PODIUM — Supabase DB Client v3
//
//  v2 → v3 변경:
//    - config.supabase.serviceRoleKey (serviceKey → serviceRoleKey)
//    - upsertProduct: SELECT+INSERT → upsert({ onConflict: 'name' })
//    - getPlatformId() 추가 — index.ts에서 기동 시 UUID 확보용
// =============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import type { NormalizedProduct, ProductRow, PriceHistoryRow } from '../types/index.js';

// -------------------------------------------------------------
//  Supabase Client (싱글턴)
// -------------------------------------------------------------
let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    // ★ Spec: serviceRoleKey 사용 (anon 키는 쓰기 권한 없음)
    _client = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { persistSession: false } },
    );
  }
  return _client;
}

// -------------------------------------------------------------
//  getPlatformId
//  index.ts 기동 시 platforms 테이블에서 실제 UUID를 조회합니다.
//  환경변수 NAVER_PLATFORM_ID에 의존하지 않고 DB에서 직접 확인.
// -------------------------------------------------------------

/**
 * 플랫폼 이름으로 platforms 테이블에서 UUID를 조회합니다.
 *
 * @param platformName  플랫폼 식별자 (예: 'naver_store', 'gs25')
 * @throws              플랫폼이 존재하지 않거나 DB 오류 시
 *
 * @example
 * const platformId = await getPlatformId('naver_store');
 */
export async function getPlatformId(platformName: string): Promise<string> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from('platforms')
    .select('id, display_name, is_active')
    .eq('name', platformName)
    .single();

  if (error) {
    throw new Error(`플랫폼 조회 실패 ("${platformName}"): ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `플랫폼 없음: "${platformName}" — Seed 데이터가 실행됐는지 확인하세요.`,
    );
  }
  if (!data.is_active) {
    throw new Error(`플랫폼 비활성 상태: "${platformName}" (is_active=false)`);
  }

  return data.id as string;
}

// -------------------------------------------------------------
//  upsertProduct
//  ★ onConflict: 'name' — 동일 상품명이 이미 있으면 UPDATE,
//    없으면 INSERT. SELECT → INSERT 패턴을 제거해 race condition 방지.
// -------------------------------------------------------------

/**
 * 상품을 products 테이블에 upsert합니다.
 *
 * DB 트리거(trg_products_before_upsert)가 unit_size/unit_type을 받아
 * normalized_unit_size/normalized_unit_type을 자동 계산합니다.
 *
 * Spec §4 매핑:
 *   parsedUnit.unit_size (원시값)  → products.unit_size   → (트리거) → normalized_unit_size
 *   parsedUnit.unit_type (원시 단위) → products.unit_type → (트리거) → normalized_unit_type
 *
 * @returns 저장된 product UUID
 */
export async function upsertProduct(product: NormalizedProduct): Promise<string> {
  const db = getSupabaseClient();

  if (!product.parsedUnit) {
    throw new Error(`단위 파싱 실패 — upsert 불가: "${product.name}"`);
  }

  const row: ProductRow = {
    name:      product.name,
    brand:     product.brand,
    category:  product.category,
    image_url: product.imageUrl,
    unit_size: product.parsedUnit.unit_size,   // 원시값 — 트리거가 정규화
    unit_type: product.parsedUnit.unit_type,   // 원시 단위 — 트리거가 정규화
  };

  const { data, error } = await db
    .from('products')
    // ★ Spec: onConflict: 'name' — 중복 에러 방지
    .upsert(row, { onConflict: 'name' })
    .select('id, normalized_unit_size, normalized_unit_type')
    .single();

  if (error) {
    throw new Error(`products upsert 실패: ${error.message}`);
  }

  return data.id as string;
}

// -------------------------------------------------------------
//  insertPriceHistory
// -------------------------------------------------------------

interface InsertedPriceHistory {
  id:              string;
  price_won:       number;
  shipping_fee:    number;
  total_price:     number;
  pack_quantity:   number;
  total_unit_size: number;
  unit_price:      number;
  price_per_unit:  number;
}

/**
 * 가격 이력을 price_history 테이블에 INSERT합니다.
 * total_price / total_unit_size / unit_price / price_per_unit 은
 * DB 트리거(trg_price_history_calc)가 자동 계산합니다.
 */
export async function insertPriceHistory(
  row: PriceHistoryRow,
): Promise<InsertedPriceHistory> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from('price_history')
    .insert(row)
    .select(
      'id, price_won, shipping_fee, total_price, ' +
      'pack_quantity, total_unit_size, unit_price, price_per_unit',
    )
    .single();

  if (error) throw new Error(`price_history INSERT 실패: ${error.message}`);
  return data as InsertedPriceHistory;
}

// -------------------------------------------------------------
//  saveProduct — 전체 파이프라인 단일 진입점
// -------------------------------------------------------------

export interface SaveResult {
  success:    boolean;
  productId?: string;
  dbRow?:     InsertedPriceHistory;
  error?:     string;
}

/**
 * 정규화된 상품 1건을 products + price_history에 저장합니다.
 *
 * @param product    NormalizedProduct (index.ts에서 빌드)
 * @param platformId getPlatformId()로 확보한 실제 UUID
 */
export async function saveProduct(
  product:    NormalizedProduct,
  platformId: string,           // ★ Spec: index.ts에서 확보한 실제 UUID 전달
): Promise<SaveResult> {
  try {
    if (!product.parsedUnit) {
      return { success: false, error: '단위 파싱 결과 없음' };
    }

    // 1단계: products upsert (onConflict: 'name')
    const productId = await upsertProduct(product);

    // 2단계: price_history insert
    //   pack_quantity = parsedUnit.quantity (묶음 수 — 트리거가 total_unit_size 계산에 사용)
    const dbRow = await insertPriceHistory({
      product_id:    productId,
      platform_id:   platformId,          // ★ 실제 UUID
      price_won:     product.priceWon,
      shipping_fee:  product.shipping.fee_won,
      pack_quantity: product.parsedUnit.quantity,
      in_stock:      true,
      source_url:    product.sourceUrl,
    });

    return { success: true, productId, dbRow };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
