// app/api/collect/route.ts
// 이 파일은 Next.js의 API Route Handler입니다.
// Vercel Cron 또는 외부 스케줄러가 HTTP GET 요청으로 이 주소를 호출하면,
// 네이버 증권 크롤링 → Supabase 적재 → Resend 이메일 발송이 자동 실행됩니다.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ==========================================
// 1. 키워드 및 테마 매핑 정의 (collect-and-mail.ts와 동일한 키워드 사용)
// ==========================================

// 반도체 테마 키워드
const SEMICONDUCTOR_KEYWORDS = [
  "반도체", "HBM", "메모리", "DRAM", "낸드", "NAND",
  "파운드리", "칩", "웨이퍼", "패키징", "CoWoS", "CXL",
  "마이크론", "TSV", "NPU", "GPU", "시스템반도체"
];

// 피지컬 AI 테마 키워드
const PHYSICAL_AI_KEYWORDS = [
  "AI", "로봇", "로보틱스", "휴머노이드",
  "자율주행", "자동화", "머신러닝", "딥러닝",
  "감속기", "액추에이터", "모터", "온디바이스",
  "엔비디아", "데이터센터"
];

// 원자력 테마 키워드
const NUCLEAR_KEYWORDS = [
  "원자력", "원전", "SMR", "핵융합",
  "소형모듈", "우라늄", "방사선",
  "원자로", "핵연료", "청정에너지"
];

// 키워드 매칭 후 테마 이름을 반환하는 함수 (매칭 없으면 null 반환)
const getTheme = (title: string): string | null => {
  const upper = title.toUpperCase();
  if (SEMICONDUCTOR_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()))) return "반도체";
  if (PHYSICAL_AI_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()))) return "피지컬 AI";
  if (NUCLEAR_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()))) return "원자력";
  return null;
};

// ==========================================
// 2. GET 요청 핸들러 (스케줄러 또는 수동 호출 시 실행됨)
// ==========================================
export async function GET(request: NextRequest) {

  // A. 보안 토큰(CRON_SECRET) 검증
  // 외부 공격자가 이 주소를 아무때나 호출하지 못하도록 보안 키를 확인합니다.
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // 키가 없거나 일치하지 않으면 401 Unauthorized 응답 반환
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // B. Supabase 및 Resend 클라이언트 초기화
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const resendKey = process.env.RESEND_API_KEY!;
  const recipientEmail = process.env.RECIPIENT_EMAIL || "atlarc@outlook.com";

  const supabase = createClient(supabaseUrl, supabaseKey);
  const resend = new Resend(resendKey);

  // C. 오늘 날짜 포맷 생성
  const today = new Date();
  const yy = String(today.getFullYear()).slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayNaverStr = `${yy}.${mm}.${dd}`; // 네이버 증권 형식: YY.MM.DD
  const todayDbStr    = `${today.getFullYear()}-${mm}-${dd}`; // DB 저장 형식: YYYY-MM-DD

  const results = {
    crawled: 0,
    filtered: 0,
    saved: 0,
    skipped: 0,
    emailSent: false,
    date: todayDbStr,
  };

  try {
    // D. axios, cheerio, iconv를 직접 사용하는 대신,
    //    Next.js 서버 환경에서는 fetch를 활용하여 네이버 증권 페이지를 요청합니다.
    const targetUrl = "https://finance.naver.com/research/company_list.naver";
    const rawResponse = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });

    if (!rawResponse.ok) {
      throw new Error(`네이버 증권 요청 실패: HTTP ${rawResponse.status}`);
    }

    // E. EUC-KR 디코딩: Next.js 서버 환경에서는 TextDecoder를 사용하여 한글 인코딩을 처리합니다.
    const arrayBuffer = await rawResponse.arrayBuffer();
    const decoder = new TextDecoder("euc-kr");
    const html = decoder.decode(arrayBuffer);

    // F. cheerio로 HTML 파싱 (동적 import 사용)
    const { load } = await import("cheerio");
    const $ = load(html);

    const savedReports: any[] = [];
    const trElements = $("table.type_1 tr").toArray();
    results.crawled = trElements.length;

    for (const tr of trElements) {
      const tds = $(tr).find("td");
      if (tds.length < 5) continue;

      const stock_name = $(tds[0]).find("a").text().trim();
      if (!stock_name) continue;

      const titleLink = $(tds[1]).find("a");
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr("href") || "";
      const detailUrl = relativeHref ? `https://finance.naver.com/research/${relativeHref}` : "";
      const brokerage = $(tds[2]).text().trim();
      const pdfLink = $(tds[3]).find("a").attr("href") || "";
      const dateRaw = $(tds[4]).text().trim();

      // 오늘 날짜가 아닌 리포트는 건너뜁니다.
      if (dateRaw !== todayNaverStr) continue;

      // 키워드 매칭이 없는 리포트는 건너뜁니다.
      const theme = getTheme(title);
      if (!theme) continue;

      results.filtered++;

      const published_at = `20${dateRaw.replace(/\./g, "-")}`;
      const report_url = pdfLink || detailUrl;

      // G. 중복 확인 후 신규 데이터만 Supabase에 삽입합니다.
      const { data: existing } = await supabase
        .from("reports")
        .select("id")
        .eq("title", title)
        .eq("published_at", published_at)
        .maybeSingle();

      if (existing) {
        results.skipped++;
        continue;
      }

      const { data: inserted, error: insertError } = await supabase
        .from("reports")
        .insert({ title, stock_name, brokerage, report_url, theme, published_at })
        .select();

      if (!insertError && inserted?.[0]) {
        savedReports.push(inserted[0]);
        results.saved++;
      }
    }

    // H. 수집 결과가 있으면 Resend를 통해 이메일을 발송합니다.
    if (savedReports.length > 0 || results.filtered > 0) {
      const grouped: Record<string, any[]> = { "반도체": [], "피지컬 AI": [], "원자력": [] };
      savedReports.forEach(r => { if (grouped[r.theme]) grouped[r.theme].push(r); });

      const subject = savedReports.length > 0
        ? `[리포트 허브] ${todayDbStr} 테마 리포트 수집 완료 (${savedReports.length}건 신규)`
        : `[리포트 허브] ${todayDbStr} 오늘 신규 리포트 없음 (기존 ${results.filtered}건 유지)`;

      const themeConfig = [
        { key: "반도체",   color: "#22d3ee", bg: "rgba(6,182,212,0.08)",   border: "rgba(6,182,212,0.25)"  },
        { key: "피지컬 AI", color: "#a78bfa", bg: "rgba(139,92,246,0.08)", border: "rgba(139,92,246,0.25)" },
        { key: "원자력",   color: "#fbbf24", bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.25)" },
      ];

      const themeBlocks = themeConfig.map(({ key, color, bg, border }) => {
        const list = grouped[key];
        if (!list?.length) return "";
        return `
          <div style="margin-bottom:20px;">
            <h3 style="font-size:13px;font-weight:bold;border-left:3px solid ${color};padding-left:8px;margin:0 0 10px;color:${color};">${key} (${list.length}건)</h3>
            <div style="background:${bg};border:1px solid ${border};border-radius:10px;padding:8px;">
              ${list.map(r => `
                <div style="padding:10px;border-bottom:1px solid rgba(30,41,59,0.4);">
                  <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
                    <span style="font-size:11px;background:#1e293b;color:#cbd5e1;padding:2px 6px;border-radius:4px;font-weight:600;">#${r.stock_name}</span>
                    <span style="font-size:11px;color:#64748b;">${r.brokerage}</span>
                  </div>
                  <div style="font-size:13px;font-weight:bold;color:#f1f5f9;line-height:1.4;margin-bottom:6px;">${r.title}</div>
                  <div style="text-align:right;">
                    <a href="${r.report_url}" style="font-size:11px;color:#22d3ee;font-weight:bold;text-decoration:none;">리포트 보기 →</a>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>`;
      }).join("");

      const emailHtml = `
        <!DOCTYPE html><html><head><meta charset="utf-8"></head>
        <body style="margin:0;padding:0;background:#020617;font-family:'Malgun Gothic',sans-serif;color:#f1f5f9;">
          <div style="max-width:600px;margin:20px auto;padding:32px 20px;background:#0b1329;border:1px solid #1e293b;border-radius:16px;">
            <div style="text-align:center;border-bottom:1px solid #1e293b;padding-bottom:20px;margin-bottom:24px;">
              <span style="font-size:11px;font-weight:bold;color:#38bdf8;border:1px solid #0369a1;background:rgba(3,105,161,0.2);padding:4px 10px;border-radius:12px;display:inline-block;margin-bottom:10px;">REPORT COLLECTOR</span>
              <h1 style="font-size:22px;font-weight:900;margin:0;color:#fff;">오늘의 테마 리포트</h1>
              <p style="font-size:12px;color:#94a3b8;margin:6px 0 0;">${todayDbStr} · 신규 ${savedReports.length}건</p>
            </div>
            <div style="display:flex;gap:10px;margin-bottom:24px;">
              ${themeConfig.map(({ key, color, bg }) => `
                <div style="flex:1;text-align:center;background:${bg};border:1px solid rgba(255,255,255,0.08);padding:10px;border-radius:8px;">
                  <div style="font-size:10px;color:${color};font-weight:bold;">${key}</div>
                  <div style="font-size:18px;font-weight:800;color:#fff;margin-top:2px;">${grouped[key]?.length ?? 0}건</div>
                </div>`).join("")}
            </div>
            ${themeBlocks || `<p style="text-align:center;color:#64748b;font-size:13px;">오늘 신규 수집된 리포트가 없습니다.</p>`}
            <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid #1e293b;">
              <p style="font-size:11px;color:#475569;margin:0;">리포트 허브 자동 수집 서비스 · 매일 오전 8시 발송</p>
            </div>
          </div>
        </body></html>`;

      const mailRes = await resend.emails.send({
        from: "ReportHub <onboarding@resend.dev>",
        to: recipientEmail,
        subject,
        html: emailHtml,
      });

      results.emailSent = !mailRes.error;
    }

    // I. 최종 결과를 JSON으로 반환합니다.
    return NextResponse.json({ ok: true, ...results });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
