// app/api/collect/route.ts
// Next.js API Route Handler
// 네이버 증권 + 한경 컨센서스 크롤링, 페이징 순회, 필터링 후 Supabase 적재 및 메일 발송

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ==========================================
// 1. 키워드 및 테마 매핑 정의
// ==========================================
const SEMICONDUCTOR_KEYWORDS = [
  "반도체", "HBM", "메모리", "DRAM", "낸드", "NAND",
  "파운드리", "칩", "웨이퍼", "패키징", "CoWoS", "CXL",
  "마이크론", "TSV", "NPU", "GPU", "시스템반도체",
  // ⭐️ 대형주 직접 추가
  "삼성전자", "SK하이닉스", "한미반도체"
];

const PHYSICAL_AI_KEYWORDS = [
  "AI", "로봇", "로보틱스", "휴머노이드",
  "자율주행", "자동화", "머신러닝", "딥러닝",
  "감속기", "액추에이터", "모터", "온디바이스",
  "엔비디아", "데이터센터",
  // ⭐️ 대형주/관련주 추가
  "삼성전기", "두산로보틱스", "레인보우로보틱스"
];

const NUCLEAR_KEYWORDS = [
  "원자력", "원전", "SMR", "핵융합",
  "소형모듈", "우라늄", "방사선",
  "원자로", "핵연료", "청정에너지",
  // ⭐️ 관련주 추가
  "두산에너빌리티", "현대건설"
];

// 종목명과 제목 모두 검사하여 테마 반환
const getTheme = (title: string, stockName: string): string | null => {
  const upperTitle = title.toUpperCase();
  const upperStock = stockName.toUpperCase();
  
  const check = (kws: string[]) => kws.some(kw => 
    upperTitle.includes(kw.toUpperCase()) || upperStock.includes(kw.toUpperCase())
  );

  if (check(SEMICONDUCTOR_KEYWORDS)) return "반도체";
  if (check(PHYSICAL_AI_KEYWORDS)) return "피지컬 AI";
  if (check(NUCLEAR_KEYWORDS)) return "원자력";
  return null;
};

// ==========================================
// 2. GET 요청 핸들러
// ==========================================
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const resendKey = process.env.RESEND_API_KEY!;
  const recipientEmail = process.env.RECIPIENT_EMAIL || "atlarc@outlook.com";

  const supabase = createClient(supabaseUrl, supabaseKey);
  const resend = new Resend(resendKey);

  const today = new Date();
  const yy = String(today.getFullYear()).slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  
  const todayNaverStr = `${yy}.${mm}.${dd}`; // YY.MM.DD
  const todayHankyungStr = `${today.getFullYear()}-${mm}-${dd}`; // YYYY-MM-DD
  const todayDbStr = todayHankyungStr; 

  const results = { crawled: 0, filtered: 0, saved: 0, skipped: 0, emailSent: false, date: todayDbStr };
  const savedReports: any[] = [];
  const { load } = await import("cheerio");

  try {
    // ----------------------------------------------------
    // [A] 네이버 증권 수집 (전 페이지 순회)
    // ----------------------------------------------------
    let naverPage = 1;
    let keepNaverLoop = true;
    
    while (keepNaverLoop) {
      const naverUrl = `https://finance.naver.com/research/company_list.naver?page=${naverPage}`;
      const rawRes = await fetch(naverUrl, { headers: { "User-Agent": "Mozilla/5.0" }});
      if (!rawRes.ok) break;

      const buf = await rawRes.arrayBuffer();
      const html = new TextDecoder("euc-kr").decode(buf);
      const $ = load(html);
      
      const trs = $("table.type_1 tr").toArray();
      let foundTodayOnThisPage = false;

      for (const tr of trs) {
        const tds = $(tr).find("td");
        if (tds.length < 5) continue;

        const stock_name = $(tds[0]).find("a").text().trim();
        const titleLink = $(tds[1]).find("a");
        const title = titleLink.text().trim();
        const dateRaw = $(tds[4]).text().trim();
        
        if (!stock_name || !title || !dateRaw) continue;

        // 과거 날짜가 나오면 네이버 수집은 즉시 루프 완전 종료
        if (dateRaw !== todayNaverStr) {
          keepNaverLoop = false;
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
        if (existing) { results.skipped++; continue; }

        const { data: inserted } = await supabase.from("reports").insert({ title, stock_name, brokerage, report_url, theme, published_at }).select();
        if (inserted?.[0]) { savedReports.push(inserted[0]); results.saved++; }
      }

      // 페이지를 모두 뒤졌는데 '오늘' 날짜가 단 한 건도 없으면 다음 페이지도 볼 필요 없음
      if (!foundTodayOnThisPage) keepNaverLoop = false;
      naverPage++;
      
      // 혹시 모를 무한 루프 방지
      if (naverPage > 20) break;
    }

    // ----------------------------------------------------
    // [B] 한경 컨센서스 수집 (전 페이지 순회)
    // ----------------------------------------------------
    let hkPage = 1;
    let keepHkLoop = true;
    
    while (keepHkLoop) {
      // 한경 컨센서스는 sdate, edate 파라미터로 애초에 오늘 날짜만 가져오게 설정 가능합니다.
      const hkUrl = `http://consensus.hankyung.com/apps.analysis/analysis.list?sdate=${todayHankyungStr}&edate=${todayHankyungStr}&now_page=${hkPage}`;
      const rawRes = await fetch(hkUrl, { 
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "http://consensus.hankyung.com/"
        }
      });
      if (!rawRes.ok) break;

      const buf = await rawRes.arrayBuffer();
      // 한경도 euc-kr 사용
      const html = new TextDecoder("euc-kr").decode(buf);
      const $ = load(html);
      
      // 테이블 탐색
      const trs = $(".table_style01 tbody tr").toArray();
      
      if (trs.length === 0 || (trs.length === 1 && $(trs[0]).text().includes("결과가 없습니다"))) {
         keepHkLoop = false;
         break;
      }
      
      for (const tr of trs) {
        const tds = $(tr).find("td");
        if (tds.length < 6) continue;

        const dateRaw = $(tds[0]).text().trim(); // YYYY-MM-DD
        const titleLink = $(tds[1]).find("a");
        const title = titleLink.text().trim();
        // 종목명은 보통 제목에 포함되거나 별도 텍스트 처리 필요. 한경은 [종목명] 형식으로 제목 앞에 붙는 경우가 많음
        const matchStock = title.match(/^\[(.*?)\]/);
        const stock_name = matchStock ? matchStock[1].trim() : "기업/산업";
        
        const brokerage = $(tds[4]).text().trim();
        
        // 한경 컨센서스 첨부파일 링크 추출
        const onclickAttr = $(tds[5]).find("a").attr("href") || ""; // usually contains /apps.analysis/analysis.downpdf?report_idx=...
        const report_url = onclickAttr.includes("downpdf") ? `http://consensus.hankyung.com${onclickAttr}` : hkUrl;

        // 오늘 날짜인지 체크
        if (!dateRaw.includes(todayHankyungStr)) {
            keepHkLoop = false;
            continue;
        }

        results.crawled++;

        const theme = getTheme(title, stock_name);
        if (!theme) continue;

        results.filtered++;

        // 네이버에서 이미 가져왔을 수 있으므로 제목으로 중복 체크
        const { data: existing } = await supabase.from("reports").select("id").eq("title", title).eq("published_at", todayHankyungStr).maybeSingle();
        if (existing) { results.skipped++; continue; }

        const { data: inserted } = await supabase.from("reports").insert({ title, stock_name, brokerage, report_url, theme, published_at: todayHankyungStr }).select();
        if (inserted?.[0]) { savedReports.push(inserted[0]); results.saved++; }
      }
      
      hkPage++;
      if (hkPage > 20) break;
    }


    // ----------------------------------------------------
    // [C] 메일 발송 로직 (기존과 동일)
    // ----------------------------------------------------
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

    return NextResponse.json({ ok: true, ...results });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
