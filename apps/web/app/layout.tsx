import type { Metadata } from 'next';
import './styles.css';
import { QueryProvider } from './query-provider';
export const metadata:Metadata={title:'대화 공간 · AI 캐릭터',description:'AI 캐릭터와 대화하는 공간'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="ko"><body><QueryProvider>{children}</QueryProvider></body></html>;}
