import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { ExternalLink, Search, Cpu, Brain, Flame, FileText, AlertCircle, Database } from "lucide-react";

// 1. 대형 포털급 Mock 데이터 정의 (Supabase 연동이 안 되어 있을 때 개발자가 UI를 바로 확인할 수 있도록 돕습니다)
const MOCK_REPORTS = [
  {
    id: 1,
    title: "HBM4 경쟁 구도 변화 및 차세대 패키징 메모리 판가 전망",
    stock_name: "SK하이닉스",
    brokerage: "미래에셋증권",
    report_url: "https://example.com/report/1",
    theme: "반도체",
    published_at: "2026-07-12",
    created_at: "2026-07-12T09:00:00Z"
  },
  {
    id: 2,
    title: "온디바이스 AI 시장 개화와 NPU 칩 설계 벤처 국산화 동향",
    stock_name: "리벨리온",
    brokerage: "신한투자증권",
    report_url: "https://example.com/report/2",
    theme: "반도체",
    published_at: "2026-07-11",
    created_at: "2026-07-11T10:30:00Z"
  },
  {
    id: 3,
    title: "휴머노이드 로봇 상용화 임박: 자율 제어 모터 핵심 부품 분석",
    stock_name: "레인보우로보틱스",
    brokerage: "하나증권",
    report_url: "https://example.com/report/3",
    theme: "피지컬 AI",
    published_at: "2026-07-10",
    created_at: "2026-07-10T14:15:00Z"
  },
  {
    id: 4,
    title: "체코 원전 2기 신규 수주 모멘텀과 글로벌 SMR(소형 모듈 원자로) 기술력 비교",
    stock_name: "두산에너빌리티",
    brokerage: "KB증권",
    report_url: "https://example.com/report/4",
    theme: "원자력",
    published_at: "2026-07-09",
    created_at: "2026-07-09T08:00:00Z"
  },
  {
    id: 5,
    title: "CXL(컴퓨트 익스프레스 링크) 2.0 규격 제정과 차세대 DRAM 인터페이스 전망",
    stock_name: "삼성전자",
    brokerage: "NH투자증권",
    report_url: "https://example.com/report/5",
    theme: "반도체",
    published_at: "2026-07-08",
    created_at: "2026-07-08T11:00:00Z"
  },
  {
    id: 6,
    title: "피지컬 AI 가속화에 따른 감속기 및 정밀 제어 센서 업계 공급망 분석",
    stock_name: "에스피지",
    brokerage: "한국투자증권",
    report_url: "https://example.com/report/6",
    theme: "피지컬 AI",
    published_at: "2026-07-07",
    created_at: "2026-07-07T16:45:00Z"
  },
  {
    id: 7,
    title: "글로벌 청정에너지 수요 급증에 따른 대형 원전 기자재 공급망 진단",
    stock_name: "우진",
    brokerage: "삼성증권",
    report_url: "https://example.com/report/7",
    theme: "원자력",
    published_at: "2026-07-06",
    created_at: "2026-07-06T13:20:00Z"
  }
];

// 테마 필터 정의
const THEMES = ["전체", "반도체", "피지컬 AI", "원자력"];

// Next.js 15 App Router 타입 정의 (searchParams는 비동기 객체로 전달됨)
interface PageProps {
  searchParams: Promise<{
    theme?: string;
    search?: string;
  }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  // 2. 비동기 searchParams 해결(Resolution)
  const params = await searchParams;
  const currentTheme = params.theme || "전체";
  const searchQuery = params.search || "";

  // 3. Supabase 데이터 조회 또는 Mock 데이터 폴백 로직 정의
  let reports = [];
  let isUsingMock = false;
  let errorMessage = "";

  if (supabase) {
    try {
      // Supabase 쿼리 빌더 빌드
      let query = supabase
        .from("reports")
        .select("*")
        .order("published_at", { ascending: false });

      // 테마별 필터링
      if (currentTheme !== "전체") {
        query = query.eq("theme", currentTheme);
      }

      // 종목명 또는 제목 검색 필터링
      if (searchQuery) {
        query = query.or(`stock_name.ilike.%${searchQuery}%,title.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      reports = data || [];
    } catch (err: any) {
      console.error("Supabase 데이터 조회 오류:", err.message);
      errorMessage = err.message;
      isUsingMock = true;
    }
  } else {
    // Supabase 접속 정보가 설정되지 않은 초기 단계에는 Mock 데이터를 사용합니다.
    isUsingMock = true;
  }

  // 4. Mock 데이터 필터링 처리 (폴백 모드일 때 작동)
  if (isUsingMock) {
    reports = MOCK_REPORTS.filter((report) => {
      const matchesTheme = currentTheme === "전체" || report.theme === currentTheme;
      const matchesSearch =
        searchQuery === "" ||
        report.stock_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        report.title.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesTheme && matchesSearch;
    });
  }

  // 테마별 컬러 매핑 헬퍼 함수
  const getThemeColorClass = (theme: string) => {
    switch (theme) {
      case "반도체":
        return "text-cyan-400 bg-cyan-950/40 border-cyan-800/30";
      case "피지컬 AI":
        return "text-violet-400 bg-violet-950/40 border-violet-800/30";
      case "원자력":
        return "text-amber-400 bg-amber-950/40 border-amber-800/30";
      default:
        return "text-slate-400 bg-slate-800/40 border-slate-700/30";
    }
  };

  // 테마별 아이콘 매핑 헬퍼 함수
  const getThemeIcon = (theme: string) => {
    switch (theme) {
      case "반도체":
        return <Cpu className="w-4 h-4 mr-1.5" />;
      case "피지컬 AI":
        return <Brain className="w-4 h-4 mr-1.5" />;
      case "원자력":
        return <Flame className="w-4 h-4 mr-1.5" />;
      default:
        return <FileText className="w-4 h-4 mr-1.5" />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-500 selection:text-slate-950">
      
      {/* 5. 배경 네온 장식 (글래스모피즘 무드 극대화) */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />
      
      <div className="max-w-6xl mx-auto px-4 py-12 md:py-16">
        
        {/* 6. 메인 헤더 영역 */}
        <header className="mb-12 text-center md:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-800 bg-slate-900/60 backdrop-blur-md text-xs text-slate-400 mb-4">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            실시간 테마별 리서치 수집 플랫폼
          </div>
          <h1 className="text-3xl md:text-5xl font-black tracking-tight mb-4">
            국내 증시 <span className="bg-gradient-to-r from-cyan-400 via-violet-400 to-amber-400 bg-clip-text text-transparent">리포트 허브</span>
          </h1>
          <p className="text-slate-400 max-w-2xl text-sm md:text-base leading-relaxed">
            반도체, 피지컬 AI, 원자력 분야의 주요 기관 리포트를 자동 수집하여 매일 아침 메일링 및 실시간 대시보드 뷰를 제공합니다.
          </p>
        </header>

        {/* 7. 데이터 상태 표시 배너 (교육자 및 개발자를 위한 Supabase 연동 알림창) */}
        {isUsingMock && (
          <div className="mb-8 p-4 rounded-xl border border-amber-900/40 bg-amber-950/20 backdrop-blur-md text-amber-300 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-sm md:text-base flex items-center gap-1.5">
                <Database className="w-4 h-4" />
                로컬 Mock 데이터 표시 중
              </h4>
              <p className="text-xs text-amber-400/80 mt-1 leading-relaxed">
                {errorMessage 
                  ? `Supabase 쿼리 오류: ${errorMessage}. 테이블이 없거나 접속 설정에 문제가 있습니다.`
                  : "현재 Supabase 환경 변수가 설정되지 않아 로컬 테스트용 Mock 데이터를 표시하고 있습니다. 테이블을 배포하고 .env.local 설정을 적용하면 실시간 연동이 시작됩니다."}
              </p>
            </div>
          </div>
        )}

        {/* 8. 필터 & 검색 툴바 (자바스크립트 상태 관리가 필요 없는 정적 GET Form 방식) */}
        <div className="mb-8 flex flex-col md:flex-row gap-4 justify-between items-center bg-slate-900/40 border border-slate-800/80 p-4 rounded-2xl backdrop-blur-md">
          
          {/* 테마 분류 탭 링크 필터 */}
          <div className="flex flex-wrap gap-1.5 w-full md:w-auto">
            {THEMES.map((theme) => {
              const isActive = currentTheme === theme;
              // 탭 이동 시 검색어는 유지되도록 URL 생성
              const url = `?theme=${encodeURIComponent(theme)}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ""}`;
              
              return (
                <Link
                  key={theme}
                  href={url}
                  className={`px-4 py-2 rounded-xl text-xs md:text-sm font-semibold transition-all duration-300 ${
                    isActive
                      ? "bg-slate-100 text-slate-950 shadow-lg shadow-white/5 scale-[1.02]"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  {theme}
                </Link>
              );
            })}
          </div>

          {/* 종목명/제목 검색창 (엔터 혹은 돋보기 아이콘 서브밋) */}
          <form className="relative w-full md:w-80" method="GET" action="">
            {/* 테마 정보를 유지하면서 검색되도록 hidden input 설정 */}
            <input type="hidden" name="theme" value={currentTheme} />
            <input
              type="text"
              name="search"
              defaultValue={searchQuery}
              placeholder="종목명 또는 제목 검색..."
              className="w-full bg-slate-950/60 border border-slate-800 text-sm pl-10 pr-4 py-2.5 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/80 transition-all"
            />
            <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-500 pointer-events-none" />
          </form>

        </div>

        {/* 9. 리포트 그리드 목록 */}
        {reports.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {reports.map((report) => (
              <article
                key={report.id}
                className="group relative flex flex-col justify-between p-6 rounded-2xl border border-slate-800/80 bg-slate-900/30 hover:bg-slate-900/60 hover:border-slate-700/60 hover:shadow-[0_0_30px_rgba(255,255,255,0.02)] transition-all duration-300"
              >
                <div>
                  {/* 카드 상단: 테마 뱃지 및 발행 증권사 */}
                  <div className="flex items-center justify-between mb-4">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-bold border ${getThemeColorClass(
                        report.theme
                      )}`}
                    >
                      {getThemeIcon(report.theme)}
                      {report.theme}
                    </span>
                    <span className="text-[11px] text-slate-500 font-medium">
                      {report.brokerage}
                    </span>
                  </div>

                  {/* 카드 중앙: 리포트 제목 및 종목명 */}
                  <h3 className="text-base font-bold text-slate-100 group-hover:text-cyan-400 transition-colors leading-snug mb-3">
                    {report.title}
                  </h3>
                  
                  {/* 대상 종목 뱃지 */}
                  <div className="mb-6">
                    <span className="inline-block px-2 py-0.5 bg-slate-800/60 rounded-full text-xs text-slate-300 font-semibold border border-slate-700/30">
                      #{report.stock_name}
                    </span>
                  </div>
                </div>

                {/* 카드 하단: 작성일 및 리포트 이동 링크 */}
                <div className="flex items-center justify-between pt-4 border-t border-slate-800/50 mt-auto">
                  <span className="text-[11px] text-slate-500">
                    발행: {report.published_at}
                  </span>
                  
                  <a
                    href={report.report_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    리포트 보기
                    <ExternalLink className="w-3 h-3 ml-1" />
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : (
          /* 리포트 결과가 없는 경우 */
          <div className="text-center py-20 bg-slate-900/20 border border-slate-800/80 rounded-2xl">
            <FileText className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-400 mb-1">검색된 리포트가 없습니다</h3>
            <p className="text-xs text-slate-500">다른 키워드를 검색하거나 필터 구성을 변경해 보세요.</p>
          </div>
        )}

      </div>
    </div>
  );
}

