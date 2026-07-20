// lib/supabase.ts
// Supabase 데이터베이스와의 통신을 위한 클라이언트 초기화 파일입니다.
// Next.js의 서버 사이드 및 클라이언트 사이드 모두에서 재사용할 수 있습니다.

import { createClient } from '@supabase/supabase-js';

// .env.local 또는 배포 환경의 환경변수에서 Supabase 접속 정보를 가져옵니다.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// 환경변수가 누락되었을 경우 클라이언트를 생성하지 않고 null을 설정하여,
// 로컬 테스트 시 Mock 데이터 폴백 처리가 원활히 동작하도록 우회 처리합니다.
export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
