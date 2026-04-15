// =============================================================
//  PODIUM — Config v4.1
//  환경변수 로드 & 검증
//
//  v4 → v4.1 변경:
//    - NAVER_PLATFORM_ID: requireEnv → optional
//      getPlatformId()가 DB에서 직접 조회하므로 미설정 시에도 정상 동작
// =============================================================
import * as dotenv from 'dotenv';

dotenv.config();

/** 필수 환경변수. 값이 없으면 즉시 에러를 던져 기동을 막습니다. */
function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`❌ 필수 환경변수 누락: ${key}  (.env 파일을 확인하세요)`);
  return val;
}

export const config = {
  naver: {
    clientId:     requireEnv('NAVER_CLIENT_ID'),
    clientSecret: requireEnv('NAVER_CLIENT_SECRET'),
    /** 1회 검색 결과 수 (최대 100) */
    display: parseInt(process.env['NAVER_DISPLAY'] ?? '20', 10),
    /** API 호출 간 딜레이 ms */
    delayMs: parseInt(process.env['NAVER_DELAY_MS'] ?? '300', 10),
  },
  supabase: {
    url:            requireEnv('SUPABASE_URL'),
    serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  },
  /**
   * 네이버스토어 platform UUID — 선택 사항(Optional).
   * 값이 있으면 참고용으로 사용 가능하나, 실제 저장 시에는
   * getPlatformId('naver_store')가 DB를 직접 조회하므로 없어도 무관.
   * 미설정 시 process.exit(1) 없이 정상 기동됨.
   */
  naverPlatformId: process.env['NAVER_PLATFORM_ID'] as string | undefined,
} as const;
