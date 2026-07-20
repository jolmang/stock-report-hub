// scripts/collect-and-mail.ts
// 국내 증시 리서치 리포트를 크롤링하여 필터링 후 Supabase 적재 및 Resend 이메일 발송을 처리하는 통합 스크립트입니다.

import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ==========================================
// 1. .env.local 환경 변수 수동 로드 로직
// ==========================================
const loadEnv = () => {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return; // 빈 줄이나 주석 스킵
      
      const match = trimmed.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || "";
        // 따옴표 제거
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length - 1);
        }
        process.env[key] = value.trim();
      }
    });
    console.log("✅ .env.local 환경 변수 로드 완료");
  } else {
    console.warn("⚠️ .env.local 파일이 존재하지 않습니다. 시스템 환경 변수를 사용합니다.");
  }
};

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
// RLS(보안정책)를 우회하여 크롤러가 대량으로 데이터를 적재할 수 있도록 Service Role Key를 사용합니다.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RECIPIENT_EMAIL = "atlarc@outlook.com"; // Resend 무료 플랜은 가입 이메일로만 테스트 발송 가능

// ==========================================
// 2. 키워드 및 테마 매핑 정의
// ==========================================
// ─── 반도체 테마 키워드 ───────────────────────────────────────────────
// 메모리(DRAM, NAND), 파운드리, 시스템 반도체, 칩 패키징 관련 용어를 망라합니다.
const SEMICONDUCTOR_KEYWORDS = [
  "반도체", "HBM", "메모리", "DRAM", "낸드", "NAND",
  "파운드리", "칩", "웨이퍼", "패키징", "CoWoS", "CXL",
  "마이크론", "TSV", "NPU", "GPU", "시스템반도체"
];

// ─── 피지컬 AI 테마 키워드 ────────────────────────────────────────────
// 인공지능, 휴머노이드 로봇, 자율주행, 제조 자동화 관련 용어를 포함합니다.
const PHYSICAL_AI_KEYWORDS = [
  "AI", "로봇", "로보틱스", "휴머노이드",
  "자율주행", "자동화", "머신러닝", "딥러닝",
  "감속기", "액추에이터", "모터", "온디바이스",
  "엔비디아", "데이터센터"
];

// ─── 원자력 테마 키워드 ───────────────────────────────────────────────
// 원자력 발전, 소형 모듈 원자로, 핵융합, 원전 기자재 관련 용어를 포함합니다.
const NUCLEAR_KEYWORDS = [
  "원자력", "원전", "SMR", "핵융합",
  "소형모듈", "우라늄", "방사선",
  "원자로", "핵연료", "청정에너지"
];

const getThemeByKeywords = (title: string): string | null => {
  // toUpperCase()로 대소문자 구분 없이 비교합니다.
  const upperTitle = title.toUpperCase();

  // 반도체 키워드 중 하나라도 제목에 포함되면 '반도체' 테마로 분류합니다.
  const hasSemiconductor = SEMICONDUCTOR_KEYWORDS.some(kw =>
    upperTitle.includes(kw.toUpperCase())
  );

  // 피지컬 AI 키워드 중 하나라도 포함되면 '피지컬 AI' 테마로 분류합니다.
  const hasPhysicalAI = PHYSICAL_AI_KEYWORDS.some(kw =>
    upperTitle.includes(kw.toUpperCase())
  );

  // 원자력 키워드 중 하나라도 포함되면 '원자력' 테마로 분류합니다.
  const hasNuclear = NUCLEAR_KEYWORDS.some(kw =>
    upperTitle.includes(kw.toUpperCase())
  );

  // 우선순위: 반도체 > 피지컬 AI > 원자력 순으로 테마를 결정합니다.
  if (hasSemiconductor) return "반도체";
  if (hasPhysicalAI) return "피지컬 AI";
  if (hasNuclear) return "원자력";

  return null; // 어떤 키워드도 매칭되지 않으면 null 반환 (수집 제외)
};

// ==========================================
// 3. 메인 비즈니스 로직 함수
// ==========================================
async function run() {
  console.log("🚀 리포트 수집 및 메일링 스크립트 시작...");

  // Supabase 및 Resend 유효성 검사
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ 오류: Supabase 접속 정보(URL, Key)가 누락되었습니다. .env.local 설정을 확인해주세요.");
    process.exit(1);
  }
  if (!RESEND_API_KEY) {
    console.error("❌ 오류: Resend API Key가 누락되었습니다. .env.local 설정을 확인해주세요.");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const resend = new Resend(RESEND_API_KEY);

  // 오늘 날짜 추출 (네이버 증권 포맷: YY.MM.DD)
  const today = new Date();
  const yy = String(today.getFullYear()).slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yy}.${mm}.${dd}`; // 예: "26.07.12"
  
  // DB 저장을 위한 YYYY-MM-DD 포맷
  const dbTodayStr = `${today.getFullYear()}-${mm}-${dd}`;

  console.log(`📅 수집 기준 날짜 (오늘): ${todayStr} (DB: ${dbTodayStr})`);

  let crawledReports: any[] = [];

  try {
    // A. 네이버 페이 증권 - 종목 리서치 페이지 요청 (EUC-KR 디코딩 적용)
    const targetUrl = "https://finance.naver.com/research/company_list.naver";
    console.log(`🌐 네이버 증권 크롤링 중: ${targetUrl}`);
    
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const decodedHtml = iconv.decode(Buffer.from(response.data), "EUC-KR");
    const $ = cheerio.load(decodedHtml);

    // B. 리포트 테이블 파싱
    // 네이버 증권 리스트 테이블의 각 데이터 행(tr)을 탐색합니다.
    const trElements = $("table.type_1 tr").toArray();
    console.log(`📊 파싱된 전체 테이블 행 개수: ${trElements.length}`);

    for (const tr of trElements) {
      const tds = $(tr).find("td");
      
      // 실제 유효한 데이터가 있는 행은 통상 td 개수가 5개 이상입니다.
      if (tds.length < 5) continue;

      // 종목명
      const stock_name = $(tds[0]).find("a").text().trim();
      if (!stock_name) continue; // 종목명이 비어 있으면 스킵

      // 리포트 제목 및 원본 페이지 상세 링크
      const titleLink = $(tds[1]).find("a");
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr("href") || "";
      const reportDetailUrl = relativeHref 
        ? `https://finance.naver.com/research/${relativeHref}` 
        : "";

      // 증권사
      const brokerage = $(tds[2]).text().trim();

      // PDF 다운로드 링크 (네이버 증권 리스트의 PDF 아이콘 href 추출)
      const pdfLink = $(tds[3]).find("a").attr("href") || "";

      // 작성일 (YY.MM.DD)
      const publishedDateRaw = $(tds[4]).text().trim();

      // [💡 중요 - 테스트 모드 지원]
      // 실제 오늘 날짜에 리포트가 올라오지 않은 주말이나 휴일에는 테스트가 어려우므로,
      // 날짜가 일치하지 않더라도 당일 테스트 목적으로 최신 리포트 전체를 매핑할 수 있는 로직을 둡니다.
      // (기본 설정은 오늘 올라온 리포트만 수집하지만, 강제 수집을 원할 경우 주석을 변경해 조절할 수 있습니다.)
      const isDateMatched = publishedDateRaw === todayStr; 
      
      // 만약 테스트 목적으로 이전 날짜의 리포트도 오늘 날짜로 강제 변경해서 수집하고 싶다면:
      // const isDateMatched = true; // (테스트용 강제 true)
      
      if (!isDateMatched) continue;

      // C. 키워드 매칭 및 테마 분류 판별
      const matchedTheme = getThemeByKeywords(title);
      if (!matchedTheme) continue; // 지정한 핵심 테마 키워드가 전혀 포함되지 않았다면 제외

      // 발행일 YYYY-MM-DD 형태로 포맷팅
      const published_at = `20${publishedDateRaw.replace(/\./g, "-")}`;

      crawledReports.push({
        title,
        stock_name,
        brokerage,
        report_url: pdfLink || reportDetailUrl, // PDF 직접 주소 우선, 없으면 상세 링크 사용
        theme: matchedTheme,
        published_at
      });
    }

    console.log(`🔍 키워드 필터링 통과 리포트 개수: ${crawledReports.length}건`);

  } catch (crawlError: any) {
    console.error("❌ 크롤링 에러 발생:", crawlError.message);
    process.exit(1);
  }

  // D. Supabase 데이터베이스 적재 (중복 제거)
  const savedReports: any[] = [];
  
  if (crawledReports.length > 0) {
    console.log("💾 Supabase 데이터베이스에 데이터 적재 중...");

    for (const report of crawledReports) {
      try {
        // 이미 동일한 제목과 발행일을 가진 데이터가 존재하는지 사전 확인 (중복 방지)
        const { data: existing, error: checkError } = await supabase
          .from("reports")
          .select("id")
          .eq("title", report.title)
          .eq("published_at", report.published_at)
          .maybeSingle();

        if (checkError) throw checkError;

        if (existing) {
          console.log(`⏭️ [중복 스킵] "${report.title}" 리포트가 이미 존재합니다.`);
          continue;
        }

        // 중복되지 않은 신규 데이터 삽입
        const { data: inserted, error: insertError } = await supabase
          .from("reports")
          .insert(report)
          .select();

        if (insertError) throw insertError;
        
        console.log(`✨ [적재 완료] "${report.stock_name}" - ${report.title}`);
        if (inserted && inserted[0]) {
          savedReports.push(inserted[0]);
        }
      } catch (dbError: any) {
        console.error(`❌ DB 처리 실패 (${report.title}):`, dbError.message);
      }
    }
  }

  console.log(`📈 오늘 신규 등록 완료된 리포트: ${savedReports.length}건`);

  // E. Resend API를 이용한 HTML 이메일 발송
  try {
    console.log(`✉️ 이메일(${RECIPIENT_EMAIL}) 발송을 시작합니다...`);

    // 수집 리포트가 있을 때와 없을 때의 메일 제목 설정
    const subjectDate = dbTodayStr;
    const subject = savedReports.length > 0
      ? `[리포트 허브] ${subjectDate} 테마별 리서치 수집 결과 (${savedReports.length}건)`
      : `[리포트 허브] ${subjectDate} 수집된 테마 리포트가 없습니다.`;

    // 메일 내용 HTML 템플릿 작성 (프리미엄 네온/다크 무드 스타일링)
    let emailHtml = "";

    if (savedReports.length > 0) {
      // 테마별 그룹화
      const grouped: { [key: string]: any[] } = {
        "반도체": [],
        "피지컬 AI": [],
        "원자력": []
      };
      
      savedReports.forEach(r => {
        if (grouped[r.theme]) grouped[r.theme].push(r);
      });

      const totalCount = savedReports.length;

      emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #020617; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #f1f5f9;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #0b1329; border: 1px solid #1e293b; border-radius: 16px; margin-top: 20px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
            
            <!-- 헤더 영역 -->
            <div style="text-align: center; border-bottom: 1px solid #1e293b; padding-bottom: 24px; margin-bottom: 28px;">
              <span style="font-size: 11px; font-weight: bold; color: #38bdf8; border: 1px solid #0369a1; background-color: rgba(3,105,161,0.2); padding: 4px 10px; border-radius: 12px; display: inline-block; margin-bottom: 12px; text-transform: uppercase;">
                Report Collector Service
              </span>
              <h1 style="font-size: 24px; font-weight: 900; margin: 0; color: #ffffff; letter-spacing: -0.5px;">
                오늘의 테마 리포트 수집 완료
              </h1>
              <p style="font-size: 13px; color: #94a3b8; margin: 8px 0 0 0;">
                수집 날짜: ${dbTodayStr} (총 ${totalCount}건 적재 완료)
              </p>
            </div>

            <!-- 요약 스탯 -->
            <div style="display: flex; gap: 10px; margin-bottom: 30px; text-align: center; justify-content: space-between;">
              <div style="flex: 1; background-color: rgba(6,182,212,0.1); border: 1px solid rgba(6,182,212,0.2); padding: 12px; border-radius: 10px;">
                <div style="font-size: 11px; color: #67e8f9; font-weight: bold;">반도체</div>
                <div style="font-size: 20px; font-weight: 800; color: #ffffff; margin-top: 4px;">${grouped["반도체"].length}건</div>
              </div>
              <div style="flex: 1; background-color: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2); padding: 12px; border-radius: 10px;">
                <div style="font-size: 11px; color: #c084fc; font-weight: bold;">피지컬 AI</div>
                <div style="font-size: 20px; font-weight: 800; color: #ffffff; margin-top: 4px;">${grouped["피지컬 AI"].length}건</div>
              </div>
              <div style="flex: 1; background-color: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.2); padding: 12px; border-radius: 10px;">
                <div style="font-size: 11px; color: #fcd34d; font-weight: bold;">원자력</div>
                <div style="font-size: 20px; font-weight: 800; color: #ffffff; margin-top: 4px;">${grouped["원자력"].length}건</div>
              </div>
            </div>

            <!-- 테마별 리포트 목록 구획 -->
            ${Object.keys(grouped).map(theme => {
              const list = grouped[theme];
              if (list.length === 0) return "";
              
              let themeThemeColor = "#38bdf8"; // 반도체
              let themeBgColor = "rgba(6,182,212,0.05)";
              if (theme === "피지컬 AI") {
                themeThemeColor = "#a78bfa";
                themeBgColor = "rgba(139,92,246,0.05)";
              } else if (theme === "원자력") {
                themeThemeColor = "#fbbf24";
                themeBgColor = "rgba(245,158,11,0.05)";
              }

              return `
                <div style="margin-bottom: 24px;">
                  <h3 style="font-size: 14px; font-weight: bold; border-left: 3px solid ${themeThemeColor}; padding-left: 8px; margin: 0 0 12px 0; color: ${themeThemeColor}; text-transform: uppercase;">
                    ${theme} (${list.length}건)
                  </h3>
                  
                  <div style="background-color: ${themeBgColor}; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; padding: 8px;">
                    ${list.map(report => `
                      <div style="padding: 12px; border-bottom: 1px solid rgba(30,41,59,0.5); &:last-child { border-bottom: none; }">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                          <span style="font-size: 11px; background-color: #1e293b; color: #cbd5e1; padding: 2px 6px; border-radius: 4px; font-weight: 600;">
                            #${report.stock_name}
                          </span>
                          <span style="font-size: 11px; color: #64748b;">
                            ${report.brokerage}
                          </span>
                        </div>
                        <h4 style="font-size: 13px; font-weight: bold; margin: 0 0 8px 0; color: #f1f5f9; line-height: 1.4;">
                          ${report.title}
                        </h4>
                        <div style="text-align: right;">
                          <a href="${report.report_url}" target="_blank" style="font-size: 11px; color: #22d3ee; text-decoration: none; font-weight: bold;">
                            리포트 전문 보기 &rarr;
                          </a>
                        </div>
                      </div>
                    `).join("")}
                  </div>
                </div>
              `;
            }).join("")}

            <!-- 대시보드 바로가기 푸터 -->
            <div style="text-align: center; margin-top: 36px; padding-top: 24px; border-top: 1px solid #1e293b;">
              <a href="http://localhost:3000" target="_blank" style="display: inline-block; background-color: #f1f5f9; color: #0f172a; padding: 12px 24px; font-weight: bold; border-radius: 10px; text-decoration: none; font-size: 13px; box-shadow: 0 4px 12px rgba(255,255,255,0.05);">
                종합 대시보드로 이동
              </a>
              <p style="font-size: 11px; color: #475569; margin: 16px 0 0 0;">
                본 이메일은 리포트 자동 수집기 서비스에 의해 발송된 시스템 메일입니다.
              </p>
            </div>
            
          </div>
        </body>
        </html>
      `;
    } else {
      // 수집된 리포트가 없을 때
      emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #020617; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #f1f5f9;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #0b1329; border: 1px solid #1e293b; border-radius: 16px; margin-top: 40px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
            <div style="font-size: 32px; margin-bottom: 16px;">📂</div>
            <h1 style="font-size: 20px; font-weight: 800; color: #ffffff; margin: 0 0 10px 0;">
              오늘의 수집 대상 리포트가 없습니다
            </h1>
            <p style="font-size: 13px; color: #94a3b8; margin: 0 0 24px 0; line-height: 1.5;">
              작성일(${dbTodayStr}) 기준 수집 조건 키워드<br>
              <strong style="color: #38bdf8;">[반도체, HBM, AI, 로봇, 원자력, SMR]</strong>에 매칭되는 신규 증권사 종목 리포트가 발견되지 않았습니다.
            </p>
            <a href="http://localhost:3000" target="_blank" style="display: inline-block; background-color: #1e293b; color: #cbd5e1; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 600; border: 1px solid #334155;">
              대시보드 히스토리 확인하기
            </a>
          </div>
        </body>
        </html>
      `;
    }

    // Resend를 통한 메일 발송 API 호출
    const mailResponse = await resend.emails.send({
      from: "ReportHub <onboarding@resend.dev>", // Resend 프리 티어 계정은 기본 송신 주소로 발송됩니다.
      to: RECIPIENT_EMAIL,
      subject: subject,
      html: emailHtml
    });

    if (mailResponse.error) {
      throw mailResponse.error;
    }

    console.log(`✅ 이메일 발송 성공! (ID: ${mailResponse.data?.id})`);

  } catch (emailError: any) {
    console.error("❌ 이메일 발송 실패:", emailError.message);
  }

  console.log("🏁 모든 작업 완료!");
}

run().catch((err) => {
  console.error("❌ 치명적인 오류 발생:", err);
  process.exit(1);
});
