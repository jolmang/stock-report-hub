// scripts/collect-and-mail.ts
// 로컬 테스트용 스크립트: 네이버 증권 (종목분석 + 산업분석) + 한경 컨센서스 크롤링, 페이징 순회, 필터링 후 Supabase 적재 및 메일 발송

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const loadEnv = () => {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let value = match[2] || "";
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length - 1);
        }
        process.env[match[1]] = value.trim();
      }
    });
    console.log("✅ .env.local 환경 변수 로드 완료");
  } else {
    console.warn("⚠️ .env.local 파일이 존재하지 않습니다.");
  }
};

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || "atlarc@outlook.com";

// ==========================================
// 1. 키워드 및 테마 매핑 정의
// ==========================================
const SEMICONDUCTOR_KEYWORDS = [
  "반도체", "HBM", "메모리", "DRAM", "낸드", "NAND",
  "파운드리", "칩", "웨이퍼", "패키징", "CoWoS", "CXL",
  "마이크론", "TSV", "NPU", "GPU", "시스템반도체",
  "삼성전자", "SK하이닉스", "한미반도체"
];

const PHYSICAL_AI_KEYWORDS = [
  "AI", "로봇", "로보틱스", "휴머노이드",
  "자율주행", "자동화", "머신러닝", "딥러닝",
  "감속기", "액추에이터", "모터", "온디바이스",
  "엔비디아", "데이터센터",
  "삼성전기", "두산로보틱스", "레인보우로보틱스"
];

const NUCLEAR_KEYWORDS = [
  "원자력", "원전", "SMR", "핵융합",
  "소형모듈", "우라늄", "방사선",
  "원자로", "핵연료", "청정에너지",
  "두산에너빌리티", "현대건설"
];

const TOP20_KEYWORDS = [
  "LG에너지솔루션", "삼성바이오로직스", "현대차", "기아", "셀트리온", 
  "KB금융", "POSCO홀딩스", "신한지주", "NAVER", "네이버", 
  "삼성물산", "삼성SDI", "LG화학", "카카오", "삼성생명", 
  "하나금융지주", "메리츠금융지주", "현대모비스", "LG전자"
];

const getTheme = (title: string, stockName: string): string | null => {
  const upperTitle = title.toUpperCase();
  const upperStock = stockName.toUpperCase();
  
  const check = (kws: string[]) => kws.some(kw => 
    upperTitle.includes(kw.toUpperCase()) || upperStock.includes(kw.toUpperCase())
  );

  if (check(SEMICONDUCTOR_KEYWORDS)) return "반도체";
  if (check(PHYSICAL_AI_KEYWORDS)) return "피지컬 AI";
  if (check(NUCLEAR_KEYWORDS)) return "원자력";
  if (check(TOP20_KEYWORDS)) return "시총 상위 20";
  return null;
};

// ==========================================
// 2. 메인 실행 함수
// ==========================================
async function run() {
  console.log("🚀 리포트 수집 및 메일링 스크립트 시작...");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const resend = new Resend(RESEND_API_KEY);

  const today = new Date();
  today.setDate(today.getDate() - 1); // ⭐️ 평일 리포트 테스트를 위해 어제 날짜로 강제 변경

  const yy = String(today.getFullYear()).slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  
  const todayNaverStr = `${yy}.${mm}.${dd}`; 
  const todayHankyungStr = `${today.getFullYear()}-${mm}-${dd}`;
  
  console.log(`📅 수집 기준 날짜 (오늘): 네이버(${todayNaverStr}), 한경(${todayHankyungStr})`);

  let results = { crawled: 0, filtered: 0, saved: 0, skipped: 0 };
  const savedReports: any[] = [];

  // 네이버 증권 2종류 게시판 (종목분석, 산업분석) 순회 함수
  const scrapeNaverBoard = async (boardPath: string, boardName: string) => {
    console.log(`🌐 네이버 증권 '${boardName}' 크롤링 중...`);
    let page = 1;
    let keepLoop = true;
    
    while (keepLoop) {
      console.log(`   - 페이지 ${page} 요청...`);
      const url = `https://finance.naver.com/research/${boardPath}?page=${page}`;
      const rawRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
      if (!rawRes.ok) {
        console.log(`   ❌ 페이지 ${page} 요청 실패`);
        break;
      }

      const buf = await rawRes.arrayBuffer();
      const html = new TextDecoder("euc-kr").decode(buf);
      const $ = cheerio.load(html);
      
      const trs = $("table.type_1 tr").toArray();
      let foundTodayOnThisPage = false;

      for (const tr of trs) {
        const tds = $(tr).find("td");
        if (tds.length < 5) continue;

        const stock_name = $(tds[0]).text().trim();
        const titleLink = $(tds[1]).find("a");
        const title = titleLink.text().trim();
        const dateRaw = $(tds[4]).text().trim();
        
        if (!stock_name || !title || !dateRaw) continue;

        if (dateRaw !== todayNaverStr) {
          keepLoop = false;
          continue; 
        }
        
        foundTodayOnThisPage = true;
        results.crawled++;
        
        const theme = getTheme(title, stock_name);
        if (!theme) continue;

        results.filtered++;
        
        const relativeHref = titleLink.attr("href") || "";
        const detailUrl = relativeHref ? `https://finance.naver.com/research/${relativeHref}` : "";
        const pdfLink = $(tds[3]).find("a").attr("href") || "";
        const report_url = pdfLink || detailUrl;
        const brokerage = $(tds[2]).text().trim();
        const published_at = `20${dateRaw.replace(/\./g, "-")}`;

        const { data: existing } = await supabase.from("reports").select("id").eq("title", title).eq("published_at", published_at).maybeSingle();
        if (existing) { 
          console.log(`   ⏭️ [중복 스킵] "${title}"`);
          results.skipped++; 
          continue; 
        }

        const { data: inserted, error } = await supabase.from("reports").insert({ title, stock_name, brokerage, report_url, theme, published_at }).select();
        if (error) {
          console.error(`   ❌ [DB 에러] "${title}":`, error.message);
        } else if (inserted?.[0]) { 
          console.log(`   ✨ [적재 완료] [${theme}] "${stock_name}" - ${title}`);
          savedReports.push(inserted[0]); 
          results.saved++; 
        }
      }

      if (!foundTodayOnThisPage) keepLoop = false;
      page++;
      if (page > 20) break;
    }
  };

  // ----------------------------------------------------
  // [A] 네이버 증권 수집 실행
  // ----------------------------------------------------
  await scrapeNaverBoard("company_list.naver", "종목분석");
  await scrapeNaverBoard("industry_list.naver", "산업분석");

  // ----------------------------------------------------
  // [C] 메일 발송 로직
  // ----------------------------------------------------
  console.log(`📊 수집 결과: 총 검색 ${results.crawled}건 중 테마 일치 ${results.filtered}건`);
  console.log(`📈 오늘 신규 등록 완료: ${results.saved}건 (중복 스킵 ${results.skipped}건)`);

  if (savedReports.length > 0 || results.filtered > 0) {
    console.log(`✉️ 이메일(${RECIPIENT_EMAIL}) 발송 준비...`);
    const grouped: Record<string, any[]> = { "반도체": [], "피지컬 AI": [], "원자력": [], "시총 상위 20": [] };
    savedReports.forEach(r => { if (grouped[r.theme]) grouped[r.theme].push(r); });

    const subject = savedReports.length > 0
      ? `[리포트 허브] ${todayHankyungStr} 테마 리포트 수집 완료 (${savedReports.length}건 신규)`
      : `[리포트 허브] ${todayHankyungStr} 오늘 신규 리포트 없음 (기존 ${results.filtered}건 유지)`;

    // HTML 생성 생략 (본문은 너무 길어져 간단 텍스트 발송 혹은 간략화 - 여기서는 테스트용이므로 간단 HTML 사용)
    const emailHtml = `<h1>${subject}</h1><p>오늘 신규 수집된 리포트: ${savedReports.length}건</p>`;

    try {
      const mailRes = await resend.emails.send({
        from: "ReportHub <onboarding@resend.dev>",
        to: RECIPIENT_EMAIL,
        subject,
        html: emailHtml,
      });

      if (mailRes.error) {
        console.error("❌ 이메일 발송 실패:", mailRes.error.message);
      } else {
        console.log(`✅ 이메일 발송 성공! (ID: ${mailRes.data?.id})`);
      }
    } catch (e: any) {
      console.error("❌ 이메일 발송 중 예외 발생:", e.message);
    }
  }

  console.log("🏁 모든 작업 완료!");
}

run();
