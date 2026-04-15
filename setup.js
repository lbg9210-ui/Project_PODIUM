const fs = require('fs');
const path = require('path');

// 1. 폴더 구조 정의
const dirs = [
  'src/scrapers',
  'src/utils',
];

// 2. 파일별 내용 정의
const files = {
  'src/types.ts': `export interface Product { id?: string; name: string; unit_size: number; unit_type: string; platform_id: string; }
export interface PriceHistory { product_id: string; platform_id: string; price_won: number; unit_price?: number; scraped_at: string; }`,

  'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
export const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);`,

  'src/utils/unit-parser.ts': `export function parseUnit(name: string): { size: number; type: string } {
    const regex = /(\\d+)\\s*(ml|g|l|kg|개)/i;
    const match = name.match(regex);
    if (match) {
        let size = parseFloat(match[1]);
        let type = match[2].toLowerCase();
        if (type === 'l') { size *= 1000; type = 'ml'; }
        if (type === 'kg') { size *= 1000; type = 'g'; }
        return { size, type };
    }
    return { size: 1, type: 'pcs' };
}`,

  'src/scrapers/base-scraper.ts': `export abstract class BaseScraper { abstract fetch(keyword: string): Promise<any[]>; }`,

  'src/scrapers/naver.ts': `import axios from 'axios';
import { BaseScraper } from './base-scraper';
export class NaverScraper extends BaseScraper {
    async fetch(keyword: string) {
        const response = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
            params: { query: keyword, display: 10 },
            headers: { 'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET }
        });
        return response.data.items;
    }
}`,

  'src/scrapers/cu.ts': `import { BaseScraper } from './base-scraper'; export class CUScraper extends BaseScraper { async fetch(k: string) { return []; } }`,
  'src/scrapers/gs25.ts': `import { BaseScraper } from './base-scraper'; export class GS25Scraper extends BaseScraper { async fetch(k: string) { return []; } }`,
  'src/scrapers/seveneleven.ts': `import { BaseScraper } from './base-scraper'; export class SevenScraper extends BaseScraper { async fetch(k: string) { return []; } }`,

  'src/index.ts': `import { NaverScraper } from './scrapers/naver';
import { parseUnit } from './utils/unit-parser';
import { supabase } from './supabase';

async function main() {
    const scraper = new NaverScraper();
    const keywords = ['삼다수 2L', '신라면 120g'];
    
    for (const kw of keywords) {
        console.log("Searching for: " + kw);
        const items = await scraper.fetch(kw);
        for (const item of items) {
            const { size, type } = parseUnit(item.title);
            console.log("Parsed: " + item.title + " -> " + size + type);
        }
    }
}
main();`
};

// 3. 실행 로직: 폴더 생성 및 파일 쓰기
console.log('🚀 Project_PODIUM 파일 생성 시작...');

dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('📁 폴더 생성 완료: ' + dir);
  }
});

Object.entries(files).forEach(([filePath, content]) => {
  fs.writeFileSync(filePath, content.trim());
  console.log('📄 파일 작성 완료: ' + filePath);
});

console.log('\n✅ 모든 파일이 성공적으로 배치되었습니다!');